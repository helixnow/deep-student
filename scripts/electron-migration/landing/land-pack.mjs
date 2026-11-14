#!/usr/bin/env node
// 本机：生成回服务器的落地包（git diff --binary → zstd → 分片 → MANIFEST.json），并在本机自证补丁能把 from 树变成 to 树。
//
//   node scripts/electron-migration/landing/land-pack.mjs --from base-ae4efdf9e --to assault/integration
//   node scripts/electron-migration/landing/land-pack.mjs --from auto --to assault/integration     # 增量：from 取 .landing/landing-map.json 里该分支最后一条
//
// 选项：
//   --from <rev|auto>     已落地的本机提交，首次为 base-ae4efdf9e；auto = landing-map.json 里 --branch 最后一次落地的本机 to
//   --branch <name>       目标落地分支（默认 assault/landing），写进 MANIFEST，服务器 land-apply 的 --branch 必须与它一致
//   --map <file>          landing-map.json（默认 <out>/landing-map.json，即 land-status 拉回的那份）
//   --to <rev>            要落地的本机提交（只取已提交内容；合并代理正在收尾的 MERGE_HEAD 不会进包）
//   --repo <dir>          本机仓库或其任一工作树（默认当前目录）
//   --out <dir>           输出根目录（默认 <主仓库上一级>/.landing），产物在 <out>/<to 前 12 位>/
//   --parts <n>           分片数（默认 8，对应 8 路并行 scp）；--part-size <字节|K|M> 优先
//   --level <n>           zstd 级别（默认 19）
//   --ignored-list <f>    服务器上“被忽略但跟踪”的清单（默认 <主仓库上一级>/.transfer/ignored-tracked-files.txt）
//   --allow-zone          补丁触及未传输区（example/、src-tauri/resources/、字体、bundle、pdfium 二进制）时仍继续
//   --allow-non-ancestor  from 不是 to 的祖先时仍继续
//   --base-snapshot <rev> 与服务器起点对应的本机快照提交（默认 base-ae4efdf9e）；--server-base <rev> 为服务器上的对应提交（默认 ae4efdf9e）
//   --force               输出目录已存在时重建
// 退出码：0 成功；1 核对失败或参数错误。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  SCHEMA, BASE_SNAPSHOT, EXCLUDED_PATHS, TOOL_FILES, PATCH_FILE, ARCHIVE_FILE, FROM_TREE_FILE, TO_TREE_FILE,
  MANIFEST_FILE, SUMS_FILE, LandingError, fail, git, gitLine, gitOk, revParse, lsTree, lsIndex, compareTrees,
  serializeTree, zstdCompress, zstdDecompress, sha256File, writeSums, writeJSONAtomic, readJSON, patchPaths,
  zoneOf, short, log, printUsage, isEntry, DEFAULT_BRANCH, lastLanding,
} from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseSize(s) {
  const m = /^(\d+)([KMG]?)$/i.exec(String(s));
  if (!m) fail(`无法解析大小：${s}`);
  return Number(m[1]) * { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[m[2].toUpperCase()];
}

const PATHSPEC = ['--', '.', ...EXCLUDED_PATHS.map((p) => `:(exclude)${p}`)];
const DIFF_FLAGS = ['--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '--ignore-submodules=none'];

/** `git diff --raw -z`：每个变化路径的新旧 mode/oid 与状态。 */
function rawChanges(repo, from, to) {
  const toks = git(repo, ['diff', '--raw', '-z', '--full-index', ...DIFF_FLAGS, from, to, ...PATHSPEC]).split('\0');
  const out = [];
  for (let i = 0; i + 1 < toks.length; i += 2) {
    if (!toks[i]) break;
    const [oldMode, newMode, oldOid, newOid, status] = toks[i].slice(1).split(' ');
    out.push({ path: toks[i + 1], status, oldMode, newMode, oldOid, newOid });
  }
  return out;
}

function binaryPaths(repo, from, to) {
  const set = new Set();
  for (const rec of git(repo, ['diff', '--numstat', '-z', ...DIFF_FLAGS, from, to, ...PATHSPEC]).split('\0')) {
    const [a, d, p] = rec.split('\t');
    if (a === '-' && d === '-') set.add(p);
  }
  return set;
}

/** 按 to 树里的全部 .gitignore 判断哪些路径会被忽略（与工作区、全局 excludesFile 无关）。 */
function ignoredByTree(repo, toTree, paths) {
  if (!paths.length) return [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'land-ignore-'));
  try {
    execFileSync('git', ['init', '-q', tmp]);
    for (const [p, e] of toTree) {
      if (path.posix.basename(p) !== '.gitignore') continue;
      fs.mkdirSync(path.join(tmp, path.posix.dirname(p)), { recursive: true });
      fs.writeFileSync(path.join(tmp, p), git(repo, ['cat-file', 'blob', e.oid], { encoding: 'buffer' }));
    }
    let out = '';
    try {
      out = execFileSync('git', ['-c', 'core.excludesFile=/dev/null', 'check-ignore', '--no-index', '-z', '--stdin'], {
        cwd: tmp, input: `${paths.join('\0')}\0`, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      if (e.status !== 1) throw e;
    }
    return out.split('\0').filter(Boolean).sort();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function intMerges(repo, from, to) {
  const out = git(repo, ['log', '--first-parent', '--format=%H%x09%P%x09%s', `${from}..${to}`]).trim();
  const commits = out ? out.split('\n').map((l) => {
    const [sha, parents, ...subj] = l.split('\t');
    return { sha, parents: parents.split(' '), subject: subj.join('\t') };
  }) : [];
  const merges = commits.filter((c) => /^\[INT\] merge\b/.test(c.subject)).map((c) => ({
    sha: c.sha,
    subject: c.subject,
    branch: /^\[INT\] merge\s+(\S+)/.exec(c.subject)?.[1] ?? null,
    mergedTip: c.parents[1] ?? null,
  }));
  return { firstParentCommits: commits.length, merges };
}

/** 若 --to 是某个工作树正检出的分支且该工作树处于合并中，提示只打包已提交的 HEAD。 */
function mergeInProgressNote(repo, toArg) {
  const ref = `refs/heads/${toArg}`;
  if (!gitOk(repo, ['show-ref', '--verify', '--quiet', ref])) return null;
  const blocks = git(repo, ['worktree', 'list', '--porcelain']).split('\n\n');
  for (const b of blocks) {
    const wt = /^worktree (.+)$/m.exec(b)?.[1];
    if (!wt || !b.includes(`branch ${ref}`)) continue;
    const gd = gitLine(wt, ['rev-parse', '--absolute-git-dir']);
    if (fs.existsSync(path.join(gd, 'MERGE_HEAD'))) return `${wt} 有 MERGE_HEAD（合并进行中）；只打包 ${toArg} 已提交的 HEAD，进行中的合并不在包里`;
  }
  return null;
}

export async function landPack(opts) {
  const repo = gitLine(opts.repo ?? process.cwd(), ['rev-parse', '--show-toplevel']);
  const commonDir = path.resolve(repo, gitLine(repo, ['rev-parse', '--git-common-dir']));
  const workspace = path.dirname(path.dirname(commonDir));
  const outRoot = path.resolve(opts.out ?? path.join(workspace, '.landing'));
  const ignoredList = opts.ignoredList ?? path.join(workspace, '.transfer', 'ignored-tracked-files.txt');

  let fromArg = opts.from ?? fail('缺少 --from');
  const toArg = opts.to ?? fail('缺少 --to');
  const branch = opts.branch ?? DEFAULT_BRANCH;
  const mapFile = path.resolve(opts.map ?? path.join(outRoot, 'landing-map.json'));
  if (fromArg === 'auto') {
    const map = readJSON(mapFile, null);
    const last = lastLanding(map, branch);
    if (!last) fail(`--from auto 需要 ${mapFile}（land-status 从服务器拉回的 landing-map.json），里面还没有 ${branch} 的落地记录`);
    fromArg = last.localTo;
    log(`--from auto → ${fromArg}（${branch} 最后一次落地，服务器 ${short(last.serverSha)}，${last.appliedAt}）`);
  }
  const from = revParse(repo, fromArg) || fail(`--from ${fromArg} 不是本机提交`);
  const to = revParse(repo, toArg) || fail(`--to ${toArg} 不是本机提交`);
  const base = opts.baseSnapshot
    ? { tag: opts.baseSnapshot, sha: revParse(repo, opts.baseSnapshot) || fail(`--base-snapshot ${opts.baseSnapshot} 不是本机提交`), server: opts.serverBase ?? fail('--base-snapshot 需要同时给 --server-base') }
    : { ...BASE_SNAPSHOT, server: opts.serverBase ?? BASE_SNAPSHOT.server };
  if (!opts.baseSnapshot && revParse(repo, BASE_SNAPSHOT.tag) && revParse(repo, BASE_SNAPSHOT.tag) !== BASE_SNAPSHOT.sha) {
    fail(`本机标签 ${BASE_SNAPSHOT.tag} 指向 ${revParse(repo, BASE_SNAPSHOT.tag)}，不是工具包认定的 ${BASE_SNAPSHOT.sha}`);
  }
  if (from === to) fail('from 与 to 是同一个提交，没有可落地的内容');
  if (!opts.allowNonAncestor && !gitOk(repo, ['merge-base', '--is-ancestor', from, to])) {
    fail(`${short(from)} 不是 ${short(to)} 的祖先；增量 from 必须是已落地的那个本机提交（确需如此加 --allow-non-ancestor）`);
  }
  const note = mergeInProgressNote(repo, toArg);
  if (note) log(`注意：${note}`);
  const localMap = readJSON(mapFile, null);
  if (from !== base.sha && localMap && lastLanding(localMap, branch)?.localTo !== from) {
    log(`注意：本机 landing-map.json 里 ${branch} 最后一次落地不是 ${short(from)}；服务器 land-apply 会拒绝 from 与该分支最后一次落地不一致的包`);
  }

  const outDir = path.join(outRoot, short(to));
  if (fs.existsSync(outDir)) {
    if (!opts.force) fail(`${outDir} 已存在（加 --force 重建）`);
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outDir, { recursive: true });
  log(`落地包：${short(from)}${from === base.sha ? `（${base.tag}）` : ''} → ${short(to)}，输出 ${outDir}`);

  // 1. 补丁（直接写文件，避免整段进内存）
  const patchFile = path.join(outDir, PATCH_FILE);
  const fd = fs.openSync(patchFile, 'w');
  try {
    git(repo, ['diff', '--binary', '--full-index', '--src-prefix=a/', '--dst-prefix=b/', ...DIFF_FLAGS, from, to, ...PATHSPEC], { stdout: fd });
  } finally {
    fs.closeSync(fd);
  }
  const patchBytes = fs.statSync(patchFile).size;
  if (!patchBytes) fail('补丁为空（排除 src/version.ts 后两棵树相同）');

  // 2. 核对
  const changes = rawChanges(repo, from, to);
  const binaries = binaryPaths(repo, from, to);
  const fromTree = lsTree(repo, from);
  const toTree = lsTree(repo, to);
  const inPatch = patchPaths(repo, patchFile);
  const inPatchSet = new Set(inPatch.map((p) => p.path));
  const expectedSet = new Set(changes.map((c) => c.path));
  const lost = [...expectedSet].filter((p) => !inPatchSet.has(p));
  const unexpected = [...inPatchSet].filter((p) => !expectedSet.has(p));
  if (lost.length || unexpected.length) fail(`补丁路径与 git diff 不一致：缺 ${lost.length}（${lost.slice(0, 5).join(', ')}），多 ${unexpected.length}（${unexpected.slice(0, 5).join(', ')}）`);
  const excludedLeak = [...inPatchSet].filter((p) => EXCLUDED_PATHS.includes(p));
  if (excludedLeak.length) fail(`补丁里出现了应排除的路径：${excludedLeak.join(', ')}`);

  const patchText = fs.readFileSync(patchFile, 'latin1');
  const gitBinaryCount = (patchText.match(/^GIT binary patch$/gm) ?? []).length;
  const binaryNoData = (patchText.match(/^Binary files .* differ$/gm) ?? []).length;
  const binaryList = [...binaries].sort();
  const binaryInPatch = inPatch.filter((p) => p.binary).length;
  if (binaryNoData || gitBinaryCount !== binaryList.length || binaryInPatch !== binaryList.length) {
    fail(`二进制补丁不完整：git diff 判定二进制 ${binaryList.length}，补丁里 GIT binary patch ${gitBinaryCount}，无数据的 “Binary files differ” ${binaryNoData}`);
  }

  const ignoredList28 = fs.existsSync(ignoredList) ? fs.readFileSync(ignoredList, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean) : [];
  if (!ignoredList28.length) log(`注意：找不到 ${ignoredList}，跳过“服务器被忽略但跟踪文件”核对`);
  const serverIgnoredTouched = ignoredList28.filter((p) => inPatchSet.has(p));
  if (serverIgnoredTouched.length) {
    fail(`补丁触及服务器上“被忽略但跟踪”的文件（本机基线没有、服务器有）：${serverIgnoredTouched.join(', ')}；需要单独处理`);
  }
  const addedOrModified = changes.filter((c) => c.status !== 'D').map((c) => c.path);
  const ignoredTracked = ignoredByTree(repo, toTree, addedOrModified);

  const zoneTouches = [...inPatchSet].map((p) => ({ path: p, zone: zoneOf(p) })).filter((z) => z.zone);
  if (zoneTouches.length && !opts.allowZone) {
    fail(`补丁触及快照未传输的区域（服务器上可能已有文件）：${zoneTouches.slice(0, 10).map((z) => `${z.path}［${z.zone}］`).join(', ')}；确认后加 --allow-zone`);
  }

  // 3. 自证：只用临时索引（不检出），from 树 + 补丁 = to 树
  const tmpIndex = path.join(outDir, '.selfcheck.index');
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    git(repo, ['read-tree', from], { env });
    git(repo, ['apply', '--cached', '--binary', '--whitespace=nowarn', patchFile], { env });
    const cmp = compareTrees(toTree, lsIndex(repo, { env }));
    if (!cmp.equal || cmp.extra.length) {
      fail(`自证失败：from + 补丁 ≠ to（缺 ${cmp.missing.length}，不同 ${cmp.mismatch.length}，多 ${cmp.extra.length}）：${[...cmp.missing, ...cmp.mismatch.map((m) => m.path), ...cmp.extra].slice(0, 10).join(', ')}`);
    }
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }
  log(`核对通过：${changes.length} 个文件（二进制 ${binaryList.length}，被忽略但跟踪 ${ignoredTracked.length}），临时索引自证 from + 补丁 = to`);

  // 4. 压缩（zstd 命令行多线程；没有时用 node:zlib），再用服务器同款 node:zlib 解压回验
  const archive = path.join(outDir, ARCHIVE_FILE);
  const level = Number(opts.level ?? 19);
  let codec = 'zstd-cli';
  try {
    execFileSync('zstd', ['-q', `-${level}`, '-T0', '-f', '-o', archive, patchFile], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    codec = 'node-zlib';
    fs.writeFileSync(archive, zstdCompress(fs.readFileSync(patchFile), level));
  }
  const patchSha = sha256File(patchFile);
  const archiveBuf = fs.readFileSync(archive);
  const roundTrip = zstdDecompress(archiveBuf);
  if (roundTrip.length !== patchBytes || crypto.createHash('sha256').update(roundTrip).digest('hex') !== patchSha) {
    fail('node:zlib 解压回验失败（服务器用同样的代码解压）');
  }

  // 5. 分片
  const partSize = opts.partSize ? parseSize(opts.partSize) : Math.max(64 * 1024, Math.ceil(archiveBuf.length / Number(opts.parts ?? 8)));
  const parts = [];
  for (let off = 0, i = 0; off < archiveBuf.length; off += partSize, i++) {
    const file = `${ARCHIVE_FILE}.${String(i).padStart(3, '0')}`;
    fs.writeFileSync(path.join(outDir, file), archiveBuf.subarray(off, off + partSize));
    parts.push({ file, bytes: Math.min(partSize, archiveBuf.length - off), sha256: sha256File(path.join(outDir, file)) });
  }

  // 6. 树清单（服务器据此做应用前后的精确比对）与工具脚本
  fs.writeFileSync(path.join(outDir, FROM_TREE_FILE), zstdCompress(Buffer.from(serializeTree(fromTree))));
  fs.writeFileSync(path.join(outDir, TO_TREE_FILE), zstdCompress(Buffer.from(serializeTree(toTree))));
  for (const f of TOOL_FILES) fs.copyFileSync(path.join(HERE, f), path.join(outDir, f));

  const merges = intMerges(repo, from, to);
  const count = (s) => changes.filter((c) => c.status === s).length;
  const manifest = {
    schema: SCHEMA,
    createdAt: new Date().toISOString(),
    createdOn: os.hostname(),
    from: {
      ref: opts.from, sha: from, tree: gitLine(repo, ['rev-parse', `${from}^{tree}`]),
      isBaseSnapshot: from === base.sha, subject: gitLine(repo, ['log', '-1', '--format=%s', from]),
    },
    to: { ref: toArg, sha: to, tree: gitLine(repo, ['rev-parse', `${to}^{tree}`]), subject: gitLine(repo, ['log', '-1', '--format=%s', to]) },
    baseSnapshot: base,
    serverBase: from === base.sha ? base.server : null,
    branch,
    excludedPaths: EXCLUDED_PATHS,
    stats: {
      files: changes.length, added: count('A'), modified: count('M'), deleted: count('D'), typeChanged: count('T'),
      modeOnly: changes.filter((c) => c.status === 'M' && c.oldOid === c.newOid).length,
      binary: binaryList.length, fromTreeEntries: fromTree.size, toTreeEntries: toTree.size,
    },
    binaryFiles: binaryList.map((p) => ({ path: p, oid: toTree.get(p)?.oid ?? null, bytes: toTree.has(p) ? Number(gitLine(repo, ['cat-file', '-s', toTree.get(p).oid])) : 0 })),
    ignoredTrackedInPatch: ignoredTracked,
    patch: { file: PATCH_FILE, bytes: patchBytes, sha256: patchSha, sent: false },
    archive: { file: ARCHIVE_FILE, codec, level, bytes: archiveBuf.length, sha256: sha256File(archive), sent: false },
    parts,
    trees: {
      from: { file: FROM_TREE_FILE, sha256: sha256File(path.join(outDir, FROM_TREE_FILE)), entries: fromTree.size },
      to: { file: TO_TREE_FILE, sha256: sha256File(path.join(outDir, TO_TREE_FILE)), entries: toTree.size },
    },
    tools: TOOL_FILES.map((f) => ({ file: f, sha256: sha256File(path.join(outDir, f)) })),
    intMerges: merges.merges,
    firstParentCommits: merges.firstParentCommits,
    checks: {
      patchPathsMatchDiff: true,
      binaryPatchesComplete: true,
      selfApplyIndexEqualsTo: true,
      nodeZlibRoundTrip: true,
      serverIgnoredTrackedTouched: serverIgnoredTouched,
      untransferredZoneTouches: zoneTouches,
      ignoredListSource: ignoredList28.length ? ignoredList : null,
    },
  };
  writeJSONAtomic(path.join(outDir, MANIFEST_FILE), manifest);
  fs.rmSync(archive);
  const send = [...parts.map((p) => p.file), FROM_TREE_FILE, TO_TREE_FILE, ...TOOL_FILES, MANIFEST_FILE];
  writeSums(outDir, send);

  const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MiB`;
  log(`补丁 ${mb(patchBytes)} → zstd -${level} ${mb(archiveBuf.length)}，${parts.length} 片 × ≤${mb(partSize)}；待传 ${send.length + 1} 个文件（含 ${SUMS_FILE}）`);
  log(`包含 [INT] merge ${merges.merges.length} 个（first-parent 提交 ${merges.firstParentCommits} 个）`);
  log(`下一步：node ${path.relative(process.cwd(), path.join(HERE, 'land-send.mjs'))} --pack ${outDir} --host ser-38`);
  return { outDir, manifest };
}

if (isEntry(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        from: { type: 'string' }, to: { type: 'string' }, repo: { type: 'string' }, out: { type: 'string' },
        parts: { type: 'string' }, 'part-size': { type: 'string' }, level: { type: 'string' }, 'ignored-list': { type: 'string' },
        'allow-zone': { type: 'boolean' }, 'allow-non-ancestor': { type: 'boolean' }, force: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
        'base-snapshot': { type: 'string' }, 'server-base': { type: 'string' }, branch: { type: 'string' }, map: { type: 'string' },
      },
    });
    if (values.help) printUsage(import.meta.url);
    await landPack({
      branch: values.branch, map: values.map, from: values.from, to: values.to, repo: values.repo, out: values.out, parts: values.parts, partSize: values['part-size'],
      level: values.level, ignoredList: values['ignored-list'], allowZone: values['allow-zone'],
      allowNonAncestor: values['allow-non-ancestor'], force: values.force, baseSnapshot: values['base-snapshot'], serverBase: values['server-base'],
    });
  } catch (e) {
    console.error(`land-pack 失败：${e instanceof LandingError ? e.message : e.stack}`);
    process.exit(1);
  }
}

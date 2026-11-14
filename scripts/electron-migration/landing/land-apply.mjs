#!/usr/bin/env node
// 服务器（以 dsdev 运行）：把 land-pack 生成、land-send 传来的落地包应用到 assault/landing 分支。永不改 main。
//
//   sudo -u dsdev /opt/node26/bin/node <上传目录>/land-apply.mjs --pack <上传目录> [--check-only]
//
// 流程：
//   1. 前置检查：调度已暂停（dispatch.paused.json / maintenance / hold/ds-migration 之一）、调度心跳 10 分钟内无更新、
//      ds-migration 与 ds-opencode 未运行（systemd 与进程两头看）、ds-backup 未在跑、.git 下没有别的属主的路径
//      （有则列出这些路径和只针对它们的 chown 命令，见 LANDING-RUNBOOK.md「.git 里有 root 属主的路径」）
//   2. 校验 MANIFEST、各分片与整包 sha256，用 node:zlib 解压并校验补丁
//   3. 定位起点（按 --branch 分开记账，同一个 --home 可以有多条落地分支）：
//      分支不存在 → 必须是首次包（from = base-ae4efdf9e），起点为 ae4efdf9e；
//      分支存在 → 包的 from 必须等于 landing-map.json 里该分支最后一次落地的本机 to，且分支 HEAD 等于那次的服务器 SHA
//   4. 干跑（临时索引，不碰任何工作树）：起点在本机 from 树的每个路径上完全一致 → git apply --cached
//      → 结果在本机 to 树的每个路径上完全一致，服务器独有的文件（被忽略但跟踪的 28 个、未传输区）原样不变
//   5. 落地工作树（默认 <repo>/../ds-landing，首次时建分支）里 git apply --index --binary，再比对一次 → 提交（信息带本机 from/to SHA）
//   6. 更新 <home>/landing-map.json（本机 SHA ↔ 服务器 SHA），最后一行输出 SERVER_SHA=<sha>
//   任何一步失败都回到应用前状态（首次落地则删掉本次建的工作树和分支）；main 前后都核对未变。
//
// 选项：
//   --pack <dir>            上传目录（必填）
//   --repo <dir>            服务器仓库（默认 /home/dsdev/dev/deep-student）
//   --home <dir>            落地状态目录（默认 <repo>/../landing）
//   --worktree <dir>        落地工作树（默认 <repo>/../ds-landing）
//   --branch <name>         落地分支（默认 assault/landing）
//   --server-base <rev>     首次落地的起点（默认 MANIFEST.serverBase，即 ae4efdf9e）
//   --user <name>           要求的运行用户（默认 dsdev）
//   --check-only            只做第 1–4 步，不改任何东西
//   --skip-service-checks   跳过第 1 步的 systemd/进程/暂停标记检查（只给本机模拟用）
// 退出码：0 成功（或该本机提交已落地过）；1 检查失败（已回滚或未改动）；2 回滚本身失败（按 LANDING-RUNBOOK.md 人工处理）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_BRANCH, MANIFEST_FILE, LandingError, fail, git, gitLine, gitOk, revParse, lsTree, lsIndex,
  compareTrees, readTreeFile, sha256File, validateManifest, reassemble, readJSON, writeJSONAtomic, acquireLock,
  systemctlState, unitRunning, pgrep, short, log, printUsage, isEntry, MAP_SCHEMA, branchEntries,
} from './lib.mjs';

const IN_PROGRESS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-apply', 'rebase-merge', 'BISECT_LOG'];

function exists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export function serviceChecks(repo, env = process.env) {
  const problems = [];
  const notes = [];
  for (const u of ['ds-migration', 'ds-opencode']) {
    const s = systemctlState(u);
    if (['active', 'activating', 'reloading', 'deactivating'].includes(s)) problems.push(`${u}.service 处于 ${s}`);
  }
  for (const [pattern, what] of [['oc-dispatch\\.mjs watch', '调度守护进程 oc-dispatch watch'], ['opencode serve', 'opencode serve']]) {
    const pids = pgrep(pattern);
    if (pids.length) problems.push(`${what} 仍有进程（pid ${pids.join(', ')}）`);
  }
  if (unitRunning('ds-backup.service')) problems.push('ds-backup.service 正在运行（旧版以 root 在仓库里跑 git，会留下 root 属主的对象）');
  if (systemctlState('ds-backup.timer') === 'active') notes.push('ds-backup.timer 仍启用：落地期间触发会以 root 在仓库里跑 git，建议先 systemctl stop ds-backup.timer');
  if (unitRunning('ds-fulltest.service')) notes.push('ds-fulltest.service 正在跑 main 的全量测试（只占 CPU，不影响落地）');

  const runs = path.join(repo, '.oc-runs');
  const opsDir = path.resolve(repo, '..', '..', 'ops-night');
  const hold = env.DS_HOLD_DIR || path.join(opsDir, 'hold');
  const candidates = [path.join(runs, 'dispatch.paused.json'), path.join(runs, 'maintenance.json'), path.join(opsDir, 'maintenance'), path.join(hold, 'ds-migration')];
  const markers = candidates.filter(exists);
  if (!markers.length) problems.push(`调度未暂停：${candidates.join('、')} 都不存在（coord.mjs pause-dispatch 或写 hold/ds-migration）`);

  const hb = path.join(runs, 'scheduler-heartbeat.json');
  if (exists(hb)) {
    const ageMin = (Date.now() - fs.statSync(hb).mtimeMs) / 60_000;
    if (ageMin < 10) problems.push(`调度心跳 ${ageMin.toFixed(1)} 分钟前还在更新（${hb}），调度器可能仍在跑`);
  }
  return { problems, notes, markers };
}

/**
 * .git 里不归当前用户、会让落地写失败的路径：commonDir 本身、objects/refs/logs/worktrees 下的目录（建文件要目录写权限），
 * 以及 logs/worktrees 下的普通文件（reflog 是原地追加）。返回 [{ path, uid, type }]。
 */
export function foreignPaths(commonDir, uid = process.getuid()) {
  const out = [];
  const add = (p) => {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    if (st.uid !== uid) out.push({ path: p, uid: st.uid, type: st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'link' : 'file' });
  };
  add(commonDir);
  const scan = [['objects', ['-type', 'd']], ['refs', ['-type', 'd']], ['logs', ['(', '-type', 'd', '-o', '-type', 'f', ')']], ['worktrees', ['(', '-type', 'd', '-o', '-type', 'f', ')']]];
  for (const [d, pred] of scan) {
    const dir = path.join(commonDir, d);
    if (!exists(dir)) continue;
    let listed;
    try {
      listed = execFileSync('find', [dir, '-xdev', ...pred, '!', '-uid', String(uid), '-print0'], { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      listed = String(e.stdout ?? '');
    }
    for (const p of listed.split('\0').filter(Boolean)) add(p);
  }
  return out;
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * 最小修复命令：只列出有问题的路径本身，按现属主分组，--from 限定只改仍归那个属主的，-h 不跟随符号链接
 * （以 root 执行；dsdev 在检查和修复之间把目录换成指向 /etc 的链接时，-h 改的是链接本身，且链接归 dsdev，--from=root 不匹配，什么也不改）。
 * 不用 -R：递归会碰到检查之后 dsdev 新放进去的东西。含控制字符的路径不进命令，单独列出人工处理。
 */
export function chownFix(found, { user, group }) {
  const commands = [];
  const unsafe = [];
  const byOwner = new Map();
  for (const f of found) {
    if (/[\0-\x1f\x7f]/.test(f.path)) {
      unsafe.push(f.path);
      continue;
    }
    const from = f.uid === 0 ? 'root' : String(f.uid);
    if (!byOwner.has(from)) byOwner.set(from, []);
    byOwner.get(from).push(f.path);
  }
  for (const [from, paths] of byOwner) {
    for (let i = 0; i < paths.length; i += 40) {
      commands.push(`sudo chown -h -P --from=${from} ${user}:${group} -- ${paths.slice(i, i + 40).map(shq).join(' ')}`);
    }
  }
  return { commands, unsafe };
}

function primaryGroup() {
  try {
    return execFileSync('id', ['-gn'], { encoding: 'utf8' }).trim();
  } catch {
    return String(os.userInfo().gid);
  }
}

export function foreignMessage(commonDir, found, { user, group }) {
  const { commands, unsafe } = chownFix(found, { user, group });
  const owners = [...new Set(found.map((f) => (f.uid === 0 ? 'root' : `uid ${f.uid}`)))].join('、');
  const lines = [
    `${commonDir} 里有 ${found.length} 个路径不归 ${user}（属主 ${owners}；建对象、改引用、追加 reflog 会失败）：`,
    ...found.slice(0, 20).map((f) => `    ${f.type === 'dir' ? '目录' : f.type === 'link' ? '链接' : '文件'} ${f.path}`),
    ...(found.length > 20 ? [`    …… 共 ${found.length} 个，全部在下面的命令里`] : []),
    `  以 root 执行（只改上面这些路径本身：不递归，-h 不跟随符号链接，--from 只改属主仍是 ${owners} 的）：`,
    ...commands.map((c) => `    ${c}`),
  ];
  if (unsafe.length) lines.push(`  另有 ${unsafe.length} 个路径名含控制字符，没放进命令，人工核对：${unsafe.map((p) => JSON.stringify(p)).join(', ')}`);
  lines.push('  修完重跑 --check-only。不要对整个 .git 或仓库 chown -R。');
  return lines.join('\n');
}

function worktreeOf(repo, branch) {
  for (const b of git(repo, ['worktree', 'list', '--porcelain']).split('\n\n')) {
    if (b.includes(`\nbranch refs/heads/${branch}`)) return /^worktree (.+)$/m.exec(b)[1];
  }
  return null;
}

function assertClean(wt, branch) {
  const head = gitLine(wt, ['symbolic-ref', '-q', 'HEAD']);
  if (head !== `refs/heads/${branch}`) fail(`落地工作树 ${wt} 的 HEAD 是 ${head || '分离状态'}，不是 ${branch}`);
  const gd = gitLine(wt, ['rev-parse', '--absolute-git-dir']);
  const busy = IN_PROGRESS.filter((f) => exists(path.join(gd, f)));
  if (busy.length) fail(`落地工作树 ${wt} 有进行中的操作：${busy.join(', ')}`);
  const status = git(wt, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status) fail(`落地工作树 ${wt} 不干净：${status.split('\0').filter(Boolean).slice(0, 10).join(' | ')}`);
}

/** extras（服务器独有、本机树里没有的路径）应用前后必须完全一致。 */
function sameExtras(before, after) {
  if (before.size !== after.size) return false;
  for (const [p, e] of before) {
    const a = after.get(p);
    if (!a || a.mode !== e.mode || a.oid !== e.oid) return false;
  }
  return true;
}
const pick = (map, keys) => new Map(keys.map((k) => [k, map.get(k)]));

function commitMessage(m, files) {
  const merges = m.intMerges?.length ? m.intMerges.map((x) => `- ${short(x.sha)} ${x.subject}`).join('\n') : '- （无 [INT] merge）';
  return `[LANDING] 本机 ${short(m.to.sha)}（自 ${m.from.isBaseSnapshot ? m.baseSnapshot.tag ?? short(m.from.sha) : short(m.from.sha)}），${files} 个文件

本机提交：${m.to.subject}
由 land-pack / land-apply 落地；结果树在本机 to 树的每个路径上与本机提交一致，
服务器独有的路径（被忽略但跟踪的文件、快照未传输区）保持原样。

包含的 [INT] merge：
${merges}

Local-From: ${m.from.sha}
Local-To: ${m.to.sha}
Landing-Patch-Sha256: ${m.patch.sha256}
Landing-Archive-Sha256: ${m.archive.sha256}
`;
}

export async function landApply(opts) {
  const repo = path.resolve(opts.repo ?? '/home/dsdev/dev/deep-student');
  const home = path.resolve(opts.home ?? path.join(repo, '..', 'landing'));
  const branch = opts.branch ?? DEFAULT_BRANCH;
  const packDir = path.resolve(opts.pack ?? fail('缺少 --pack'));
  const user = opts.user ?? 'dsdev';

  if (process.getuid?.() === 0) fail('不要以 root 运行（会在仓库里留下 root 属主的对象）；用 sudo -u dsdev');
  if (user && os.userInfo().username !== user) fail(`必须以 ${user} 运行，当前是 ${os.userInfo().username}`);
  if (['main', 'master'].includes(branch) || branch.startsWith('-')) fail(`拒绝把 ${branch} 当落地分支`);
  if (gitLine(repo, ['rev-parse', '--show-toplevel']) !== fs.realpathSync(repo)) fail(`${repo} 不是仓库根目录`);
  const commonDir = path.resolve(repo, gitLine(repo, ['rev-parse', '--git-common-dir']));
  if (gitOk(repo, ['symbolic-ref', '-q', '--short', 'HEAD']) && gitLine(repo, ['symbolic-ref', '-q', '--short', 'HEAD']) === branch) {
    fail(`${branch} 正被主工作树 ${repo} 检出`);
  }

  fs.mkdirSync(path.join(home, 'work'), { recursive: true });
  const releaseLock = acquireLock(path.join(home, 'apply.lock'));
  try {
    // 1. 前置检查
    if (!opts.skipServiceChecks) {
      const sc = serviceChecks(repo);
      for (const n of sc.notes) log(`注意：${n}`);
      if (sc.problems.length) fail(`前置检查未通过：\n  - ${sc.problems.join('\n  - ')}`);
      log(`[检查] 调度已暂停（${sc.markers.map((f) => path.basename(f)).join('、')}），ds-migration / ds-opencode 未运行`);
    } else {
      log('[检查] 跳过服务检查（--skip-service-checks，仅限本机模拟）');
    }
    const foreign = (opts.foreignPaths ?? foreignPaths)(commonDir);
    if (foreign.length) fail(foreignMessage(commonDir, foreign, { user: os.userInfo().username, group: opts.group ?? primaryGroup() }));
    log(`[检查] ${commonDir} 里 objects/refs/logs/worktrees 都归 ${os.userInfo().username}`);

    // 2. 包校验
    const manifest = validateManifest(readJSON(path.join(packDir, MANIFEST_FILE)));
    if (manifest.branch && manifest.branch !== branch) fail(`这个包是为 ${manifest.branch} 打的（land-pack --branch），这里的 --branch 是 ${branch}`);
    const self = fileURLToPath(import.meta.url);
    const selfEntry = manifest.tools?.find((t) => t.file === path.basename(self));
    if (selfEntry && sha256File(self) !== selfEntry.sha256) log(`注意：正在运行的 ${self} 与包内工具版本不同`);
    const workDir = path.join(home, 'work', short(manifest.to.sha));
    const patch = await reassemble(packDir, manifest, workDir);
    for (const k of ['from', 'to']) {
      const t = manifest.trees[k];
      if (sha256File(path.join(packDir, t.file)) !== t.sha256) fail(`${t.file} sha256 不符`);
    }
    const fromTree = readTreeFile(path.join(packDir, manifest.trees.from.file));
    const toTree = readTreeFile(path.join(packDir, manifest.trees.to.file));
    if (fromTree.size !== manifest.trees.from.entries || toTree.size !== manifest.trees.to.entries) fail('树清单条目数与 MANIFEST 不符');
    log(`[检查] 包完整：${manifest.parts.length} 片，补丁 ${manifest.patch.bytes} 字节，本机 ${short(manifest.from.sha)} → ${short(manifest.to.sha)}`);

    // 3. 起点
    const mapFile = path.join(home, 'landing-map.json');
    const base = manifest.baseSnapshot;
    const map = readJSON(mapFile, { schema: MAP_SCHEMA, branch, serverBase: null, baseSnapshot: base.sha, entries: [], byLocal: {}, byServer: {} });
    if (map.schema !== MAP_SCHEMA) fail(`${mapFile} 的 schema 是 ${map.schema}，不是 ${MAP_SCHEMA}`);
    map.branches ??= {};
    const mine = branchEntries(map, branch);
    const prior = mine.find((e) => e.localTo === manifest.to.sha);
    if (prior) {
      const s = prior.serverSha;
      log(`本机 ${short(manifest.to.sha)} 已在 ${branch} 落地为服务器 ${s}，不重复应用`);
      console.log(`LOCAL_SHA=${manifest.to.sha}`);
      console.log(`SERVER_SHA=${s}`);
      return { serverSha: s, already: true };
    }
    const mainBefore = gitLine(repo, ['rev-parse', '--verify', 'refs/heads/main']);
    const branchExists = gitOk(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    let startSha;
    let wt = path.resolve(opts.worktree ?? path.join(repo, '..', 'ds-landing'));
    if (!branchExists) {
      if (!manifest.from.isBaseSnapshot || manifest.from.sha !== base.sha) {
        fail(`${branch} 不存在，首次落地的包必须从 ${base.tag ?? ''}（${short(base.sha)}）开始，这个包的 from 是 ${short(manifest.from.sha)}`);
      }
      if (mine.length) fail(`${mapFile} 有 ${mine.length} 条 ${branch} 的记录但分支不存在：状态不一致，先人工核对`);
      const baseRev = opts.serverBase ?? manifest.serverBase ?? base.server;
      startSha = revParse(repo, baseRev) || fail(`服务器上找不到起点 ${baseRev}`);
      if (startSha !== mainBefore) log(`注意：main 现在是 ${short(mainBefore)}，不是快照起点 ${short(startSha)}；落地分支仍从快照起点建`);
      if (exists(wt) && fs.readdirSync(wt).length) fail(`落地工作树路径 ${wt} 已存在且非空`);
      if (!path.relative(repo, wt).startsWith('..')) fail(`落地工作树 ${wt} 不能在仓库 ${repo} 里面`);
    } else {
      const last = mine.at(-1);
      if (!last) fail(`${branch} 已存在但 ${mapFile} 没有它的落地记录（分支不是本工具建的，或首次落地用的是别的 --home）：先人工核对`);
      if (manifest.from.sha !== last.localTo) {
        fail(`这个包的 from 是本机 ${short(manifest.from.sha)}，但最后一次落地的是本机 ${short(last.localTo)}（服务器 ${short(last.serverSha)}）；本机用 land-pack --from ${last.localTo} 重新打包`);
      }
      startSha = gitLine(repo, ['rev-parse', '--verify', `refs/heads/${branch}`]);
      if (startSha !== last.serverSha) fail(`${branch} 现在是 ${short(startSha)}，不是最后一次落地记录的 ${short(last.serverSha)}：分支上有未记录的提交，先人工核对`);
      const existing = worktreeOf(repo, branch);
      if (existing) wt = existing;
    }

    // 4. 干跑（临时索引）
    const start = lsTree(repo, startSha);
    const pre = compareTrees(fromTree, start);
    if (!pre.equal) {
      fail(`起点 ${short(startSha)} 与本机 from 树不一致（缺 ${pre.missing.length}，不同 ${pre.mismatch.length}）：${[...pre.missing, ...pre.mismatch.map((x) => x.path)].slice(0, 10).join(', ')}`);
    }
    const extrasBefore = pick(start, pre.extra);
    const added = [...toTree.keys()].filter((p) => !fromTree.has(p));
    const collide = added.filter((p) => extrasBefore.has(p));
    if (collide.length) fail(`补丁新增的路径在服务器上已存在（本机基线没有）：${collide.slice(0, 10).join(', ')}`);
    const checkIndex = path.join(workDir, 'check.index');
    const env = { GIT_INDEX_FILE: checkIndex };
    git(repo, ['read-tree', startSha], { env });
    git(repo, ['apply', '--cached', '--binary', '--whitespace=nowarn', patch], { env });
    const dry = lsIndex(repo, { env });
    fs.rmSync(checkIndex, { force: true });
    const dryCmp = compareTrees(toTree, dry);
    if (!dryCmp.equal) fail(`干跑结果与本机 to 树不一致（缺 ${dryCmp.missing.length}，不同 ${dryCmp.mismatch.length}）：${[...dryCmp.missing, ...dryCmp.mismatch.map((x) => x.path)].slice(0, 10).join(', ')}`);
    if (!sameExtras(extrasBefore, pick(dry, dryCmp.extra))) fail('干跑后服务器独有的文件发生了变化');
    log(`[检查] 干跑通过：起点 ${short(startSha)} 在本机 from 树 ${fromTree.size} 个路径上一致，应用后与本机 to 树 ${toTree.size} 个路径一致；服务器独有 ${extrasBefore.size} 个路径不变`);
    if (opts.checkOnly) {
      fs.rmSync(workDir, { recursive: true, force: true });
      console.log('CHECK_OK');
      return { checkOnly: true, startSha };
    }

    // 5. 应用与提交（之后的任何失败都回滚）
    const undo = [];
    const rollback = () => {
      const errors = [];
      for (const f of undo.splice(0).reverse()) {
        try {
          f();
        } catch (e) {
          errors.push(e.message);
        }
      }
      return errors;
    };
    const onSignal = (sig) => {
      log(`收到 ${sig}，回滚`);
      const errs = rollback();
      process.exit(errs.length ? 2 : 130);
    };
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const s of signals) process.on(s, onSignal);
    try {
      if (!branchExists) {
        git(repo, ['worktree', 'add', '-q', '-b', branch, wt, startSha]);
        undo.push(() => {
          git(repo, ['worktree', 'remove', '--force', wt]);
          git(repo, ['branch', '-D', branch]);
          git(repo, ['worktree', 'prune']);
        });
        log(`建落地分支 ${branch}（起点 ${short(startSha)}），工作树 ${wt}`);
      } else if (!worktreeOf(repo, branch)) {
        git(repo, ['worktree', 'add', '-q', wt, branch]);
        undo.push(() => git(repo, ['worktree', 'remove', '--force', wt]));
        log(`为 ${branch} 重建工作树 ${wt}`);
      }
      assertClean(wt, branch);
      if (gitLine(wt, ['rev-parse', 'HEAD']) !== startSha) fail('落地工作树 HEAD 与起点不一致');
      const squatters = added.filter((p) => exists(path.join(wt, p)));
      if (squatters.length) fail(`落地工作树里已有补丁要新增的文件（被忽略的未跟踪文件）：${squatters.slice(0, 10).join(', ')}；先移走`);
      undo.push(() => {
        git(wt, ['reset', '-q', '--hard', startSha]);
        for (const p of added) {
          const f = path.join(wt, p);
          if (exists(f) && !gitOk(wt, ['cat-file', '-e', `${startSha}:${p}`])) fs.rmSync(f, { force: true });
        }
      });

      git(wt, ['apply', '--index', '--binary', '--whitespace=nowarn', patch]);
      const idx = lsIndex(wt);
      const post = compareTrees(toTree, idx);
      if (!post.equal || !sameExtras(extrasBefore, pick(idx, post.extra))) fail('应用后索引与干跑结果不一致');
      if (!gitOk(wt, ['diff', '--quiet'])) fail('应用后工作树与索引不一致');
      const untracked = git(wt, ['ls-files', '--others', '--exclude-standard', '-z']);
      if (untracked) fail(`应用后出现未跟踪文件：${untracked.split('\0').slice(0, 5).join(', ')}`);

      // opts.faults 只有函数调用能传（命令行没有入口），供 landing.test.mjs 在提交前后注入故障验证回滚
      opts.faults?.beforeCommit?.(wt);
      const msgFile = path.join(workDir, 'COMMIT_MSG');
      fs.writeFileSync(msgFile, commitMessage(manifest, manifest.stats?.files ?? added.length));
      const name = process.env.LAND_GIT_NAME || 'Deep Student Landing';
      const email = process.env.LAND_GIT_EMAIL || `${os.userInfo().username}@${os.hostname()}`;
      git(wt, ['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-q', '-F', msgFile], {
        env: { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email },
      });
      const serverSha = gitLine(wt, ['rev-parse', 'HEAD']);
      const final = compareTrees(toTree, lsTree(wt, serverSha));
      if (!final.equal || !sameExtras(extrasBefore, pick(lsTree(wt, serverSha), final.extra))) fail('提交后的树与本机 to 树不一致');
      if (gitLine(repo, ['rev-parse', '--verify', 'refs/heads/main']) !== mainBefore) fail('main 在落地过程中被改动了（不是本脚本所为），停止');
      opts.faults?.afterCommit?.(wt);

      // 6. 映射与回执
      const entry = {
        localFrom: manifest.from.sha, localTo: manifest.to.sha, localToSubject: manifest.to.subject,
        serverParent: startSha, serverSha, branch, worktree: wt,
        appliedAt: new Date().toISOString(), appliedBy: `${os.userInfo().username}@${os.hostname()}`,
        patchSha256: manifest.patch.sha256, archiveSha256: manifest.archive.sha256,
        files: manifest.stats?.files ?? null, binary: manifest.stats?.binary ?? null, serverOnlyPaths: extrasBefore.size,
        intMerges: (manifest.intMerges ?? []).map((x) => ({ sha: x.sha, branch: x.branch })),
      };
      map.serverBase ??= startSha;
      if (!map.byLocal?.[base.sha] && !branchExists) map.byLocal = { ...map.byLocal, [base.sha]: startSha };
      map.entries.push(entry);
      map.branches[branch] = {
        serverBase: map.branches[branch]?.serverBase ?? (branchExists ? mine[0]?.serverParent ?? null : startSha),
        worktree: wt, localTo: manifest.to.sha, serverSha, appliedAt: entry.appliedAt, landings: mine.length + 1,
      };
      map.byLocal = { ...map.byLocal, [manifest.to.sha]: serverSha };
      map.byServer = { ...map.byServer, [serverSha]: manifest.to.sha };
      const receiptDir = path.join(home, 'applied', short(manifest.to.sha));
      fs.mkdirSync(receiptDir, { recursive: true });
      fs.copyFileSync(path.join(packDir, MANIFEST_FILE), path.join(receiptDir, MANIFEST_FILE));
      writeJSONAtomic(path.join(receiptDir, 'apply.json'), { ...entry, serverOnly: [...extrasBefore.keys()] });
      writeJSONAtomic(mapFile, map);
      fs.rmSync(workDir, { recursive: true, force: true });
      log(`落地完成：本机 ${short(manifest.to.sha)} → 服务器 ${serverSha}（${branch}），main 仍为 ${short(mainBefore)}`);
      log(`本机下一步：node scripts/electron-migration/landing/land-status.mjs --map-only${home === path.resolve(repo, '..', 'landing') ? '' : ` --home ${home}`}（刷新 .landing/landing-map.json）`);
      console.log(`LOCAL_SHA=${manifest.to.sha}`);
      console.log(`SERVER_SHA=${serverSha}`);
      return { serverSha, entry };
    } catch (e) {
      log(`失败，回滚到应用前状态：${e.message}`);
      const errs = rollback();
      if (errs.length) {
        const err = new LandingError(`回滚失败（需人工处理）：${errs.join('；')}；原始错误：${e.message}`);
        err.exitCode = 2;
        throw err;
      }
      throw e;
    } finally {
      for (const s of signals) process.off(s, onSignal);
    }
  } finally {
    releaseLock();
  }
}

if (isEntry(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        pack: { type: 'string' }, repo: { type: 'string' }, home: { type: 'string' }, worktree: { type: 'string' },
        branch: { type: 'string' }, 'server-base': { type: 'string' }, user: { type: 'string' },
        'check-only': { type: 'boolean' }, 'skip-service-checks': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) printUsage(import.meta.url);
    await landApply({
      pack: values.pack, repo: values.repo, home: values.home, worktree: values.worktree, branch: values.branch,
      serverBase: values['server-base'], user: values.user, checkOnly: values['check-only'], skipServiceChecks: values['skip-service-checks'],
    });
  } catch (e) {
    console.error(`land-apply 失败：${e instanceof LandingError ? e.message : e.stack}`);
    process.exit(e.exitCode ?? 1);
  }
}

#!/usr/bin/env node
// 只读：lane 分支相对合并基的改动，main 是否已吸收（RESUME-RUNBOOK 第 3 步"先吸收、后重置"的判据）。
// 逐文件在临时索引里对 main 试应用：反向能应用 = 已吸收；正向能应用 = 未吸收；都不能 = 分叉（main 另行改过，需 owner 确认）。
// 不动真实索引和工作树，不写任何 ref。
//
//   node scripts/electron-migration/absorb-check.mjs [--target main] [--json] <分支>...
//   node scripts/electron-migration/absorb-check.mjs [--target <集成分支>] [--json] --patch <补丁文件>...   本机核对 .transfer/inflight/
//   输出每条分支一行：lane、可重置、已吸收/未吸收/分叉数、未吸收或分叉的非文档文件。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyFile } from './lib/progress.mjs';

const isCode = (f) => classifyFile(f) !== 'doc';

const gitIn = (repo) => (args, opts = {}) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 << 20, ...opts });
const failed = (lane, what, e) => ({ lane, error: `${what}: ${String(e.stderr || e.message).split('\n')[0]}`, absorbed: [], open: [], diverged: [], openCode: [], divergedCode: [], resettable: false });

/** 补丁里每个文件（新路径）对 target 的吸收情况；patch 须为绝对路径（git -C 下相对路径会解析错）。 */
function judge(repo, patch, files, target, out) {
  const git = gitIn(repo);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'absorb-check-'));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(tmp, 'index') };
  try {
    git(['read-tree', target], { env });
    const applies = (f, reverse) => {
      try {
        git(['apply', '--cached', '--check', ...(reverse ? ['-R'] : []), `--include=${f}`, patch], { env });
        return true;
      } catch {
        return false;
      }
    };
    Object.assign(out, { absorbed: [], open: [], diverged: [] });
    for (const f of files) out[applies(f, true) ? 'absorbed' : applies(f, false) ? 'open' : 'diverged'].push(f);
    out.openCode = out.open.filter(isCode);
    out.divergedCode = out.diverged.filter(isCode);
    out.resettable = out.openCode.length === 0 && out.divergedCode.length === 0;
    return out;
  } catch (e) {
    return failed(out.lane, target, e);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function checkBranch(repo, branch, target = 'main') {
  const lane = branch.replace(/^ds-mig\//, '');
  const git = gitIn(repo);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'absorb-branch-'));
  try {
    const base = git(['merge-base', target, branch]).trim();
    const files = git(['diff', '--name-only', base, branch]).split('\n').filter(Boolean);
    const patch = path.join(tmp, 'lane.patch');
    fs.writeFileSync(patch, git(['diff', '--binary', base, branch]));
    return judge(repo, patch, files, target, { lane, branch, base: base.slice(0, 9) });
  } catch (e) {
    return failed(lane, branch, e);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function checkPatch(repo, patchFile, target) {
  const patch = path.resolve(patchFile);
  const lane = path.basename(patch).replace(/(\.code)?\.patch$/, '');
  let text;
  try {
    text = fs.readFileSync(patch, 'utf8');
  } catch (e) {
    return failed(lane, patchFile, e);
  }
  const files = [...new Set([...text.matchAll(/^diff --git a\/.+? b\/(.+)$/gm)].map((m) => m[1]))];
  return judge(repo, patch, files, target, { lane, patch: patchFile });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const ti = argv.indexOf('--target');
  const target = ti >= 0 ? argv[ti + 1] : 'main';
  const refs = argv.filter((a, i) => !a.startsWith('--') && (ti < 0 || i !== ti + 1));
  const results = refs.map((r) => (argv.includes('--patch') ? checkPatch(process.cwd(), r, target) : checkBranch(process.cwd(), r, target)));
  if (argv.includes('--json')) console.log(JSON.stringify(results, null, 1));
  else {
    for (const r of results) {
      const rest = r.error ?? [...r.openCode.map((f) => `open:${f}`), ...r.divergedCode.map((f) => `diverged:${f}`)].join(' ');
      console.log([r.lane, r.resettable ? 'reset-ok' : 'HOLD', `${r.absorbed.length}/${r.open.length}/${r.diverged.length}`, rest].join('\t'));
    }
  }
}

/**
 * 桌面入口的 approval-scope 端口注入：`env.ts` 的 macOS developer dir 探测（`xcode-select -p`）与
 * shell guard 的 `fs::canonicalize` 都需要 `node:*`。`approval-scope.ts`（桌面 barrel）import 本文件完成注入；
 * `approval-scope/portable.ts` 不 import，移动端闭包因此不加载 Node。
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { canonicalPath } from '../runtime-paths.ts';
import { rustTrim } from '../../../../platform/util/index.ts';
import { join } from '../../../../platform/util/path.ts';
import { setMacosDeveloperDirProbe, type MacosDeveloperDir } from './env.ts';
import { setShellGuardCanonicalizer } from './shell-guard.ts';

function probeMacosDeveloperDir(): MacosDeveloperDir | null {
  let selected: string;
  try {
    selected = rustTrim(execFileSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8' }));
  } catch {
    return null;
  }
  try {
    if (!fs.statSync(selected).isDirectory()) return null;
  } catch {
    return null;
  }
  let binDir: string | null = null;
  try {
    const candidate = join(selected, 'usr', 'bin');
    if (fs.statSync(candidate).isDirectory()) binDir = candidate;
  } catch {
    binDir = null;
  }
  return { dir: selected, binDir };
}

setMacosDeveloperDirProbe(probeMacosDeveloperDir);
setShellGuardCanonicalizer(canonicalPath);

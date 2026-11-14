// Rust: src/chat_v2/tools/chatanki_transform_script.rs — 解释器探测、沙箱策略、job 目录。
// 文件访问经 `transform-script-fs.ts` 端口：桌面入口注入 `node:fs` 实现，移动端没有文件系统。
import { join, delimiter, isAbsolute, dirname, basename, resolve } from '../../../platform/util/path.ts';
import { utf8Encode } from '../../../platform/crypto/encoding.ts';
import type { TransformSandboxPolicy } from '../api.ts';
import { errorText } from './execution.ts';
import { transformFs } from './transform-script-fs.ts';

/** 桌面运行时的环境变量（移动端没有 `process`，按空环境处理）。 */
function runtimeEnvironment(): Record<string, string | undefined> {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
}
import {
  CHATANKI_INPUT_FILE, CHATANKI_OUTPUT_FILE, interpreterCandidates, scriptFileName,
  type NormalizedTransformScript, type ScriptLanguage,
} from './transform-script-spec.ts';

// ============================================================================
// 解释器探测（目录直查，不经 shell）
// ============================================================================

let jobSeq = 0;

const MACOS_INTERPRETER_DIRS = [
  '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin',
  '/usr/bin', '/bin', '/usr/sbin', '/sbin',
];
const LINUX_INTERPRETER_DIRS = [
  '/home/linuxbrew/.linuxbrew/bin', '/home/linuxbrew/.linuxbrew/sbin',
  '/usr/local/bin', '/usr/local/sbin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
];

export function interpreterSearchDirs(
  env: Record<string, string | undefined> = runtimeEnvironment(),
  platform: string = transformFs().platform,
): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  const push = (dir: string | null | undefined): void => {
    if (!dir || !isAbsolute(dir) || seen.has(dir)) return;
    seen.add(dir);
    dirs.push(dir);
  };
  const pathValue = env.PATH ?? env.Path ?? '';
  if (pathValue) for (const dir of pathValue.split(delimiter)) push(dir);
  if (platform === 'darwin') for (const dir of MACOS_INTERPRETER_DIRS) push(dir);
  else if (platform !== 'win32') for (const dir of LINUX_INTERPRETER_DIRS) push(dir);
  const home = env.HOME;
  if (home) for (const relative of ['.local/bin', '.cargo/bin', 'bin']) push(join(home, relative));
  return dirs;
}

function isExecutableFile(path: string): boolean {
  const metadata = transformFs().stat(path, true);
  if (metadata === null || metadata.kind !== 'file') return false;
  if (transformFs().platform === 'win32') return true;
  return (metadata.mode & 0o111) !== 0;
}

function isRegularFile(path: string): boolean {
  return transformFs().stat(path, true)?.kind === 'file';
}

/** 按候选名顺序解析目录集中第一个可执行文件（Rust 的 candidate 外层循环）。 */
export function resolveInterpreterInDirs(
  candidates: readonly string[], dirs: readonly string[],
): string | null {
  for (const candidate of candidates) {
    for (const dir of dirs) {
      const path = join(dir, candidate);
      if (isExecutableFile(path)) return path;
      if (transformFs().platform === 'win32') {
        for (const extension of ['exe', 'cmd', 'bat']) {
          const withExtension = join(dir, `${candidate}.${extension}`);
          if (isRegularFile(withExtension)) return withExtension;
        }
      }
    }
  }
  return null;
}

export function resolveInterpreter(language: ScriptLanguage): string | null {
  return resolveInterpreterInDirs(interpreterCandidates(language), interpreterSearchDirs());
}

// ============================================================================
// 沙箱策略与命令行
// ============================================================================

/**
 * 对 `/opt/<x>/...` 下的解释器额外放行其顶层前缀目录；`<prefix>/bin` 的解释器
 * 额外放行 `<prefix>/lib`（标准库/原生模块），但绝不放行整个 prefix。
 */
export function extraReadableRootsForInterpreter(interpreter: string): string[] {
  const canonical = transformFs().realpath(interpreter) ?? resolve(interpreter);
  const roots: string[] = [];
  const parent = dirname(canonical);
  if (parent !== canonical) {
    roots.push(parent);
    if (basename(parent) === 'bin') {
      const lib = join(dirname(parent), 'lib');
      if (isDirectory(lib)) roots.push(lib);
    }
  }
  const segments = canonical.split('/').filter((segment) => segment.length > 0);
  if (segments[0] === 'opt' && segments.length >= 2) {
    roots.push(`/opt/${segments[1]}`);
  }
  return roots;
}

function isDirectory(path: string): boolean {
  return transformFs().stat(path, true)?.kind === 'directory';
}

/** 沙箱策略：只有 job 目录可写；网络**恒禁**（无豁免参数）。 */
export function transformSandboxPolicy(jobDir: string, interpreter: string): TransformSandboxPolicy {
  return {
    readableRoots: [jobDir, ...extraReadableRootsForInterpreter(interpreter)],
    writableRoots: [jobDir],
    protectedReadRoots: [],
    protectedWriteRoots: [],
    restrictReadToRoots: true,
    allowNetwork: false,
  };
}

function shellQuotePosix(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function shellQuotePowershell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** 构造沙箱内执行的解释器命令行。python 追加 `-I`（isolated mode）。 */
export function buildShellCommand(
  shellKind: string, language: ScriptLanguage, interpreter: string, scriptPath: string,
): string {
  const interpreterArgs = language === 'python' ? ' -I' : '';
  if (shellKind === 'posix_sh') {
    return `${shellQuotePosix(interpreter)}${interpreterArgs} ${shellQuotePosix(scriptPath)}`;
  }
  if (shellKind === 'windows_powershell') {
    return `& ${shellQuotePowershell(interpreter)}${interpreterArgs} ${shellQuotePowershell(scriptPath)}`;
  }
  throw new Error(`Unsupported sandbox shell kind for transform scripts: ${shellKind}`);
}

// ============================================================================
// job 目录准备
// ============================================================================

export interface PreparedTransformJob {
  jobDir: string;
  inputPath: string;
  outputPath: string;
  scriptPath: string;
  /** 相对 temp root 的展示引用（`runtime-root://temp/...`）。 */
  jobRef: string;
}

function setPrivateJobPermissions(path: string, mode: number): void {
  if (transformFs().platform === 'win32') return;
  try {
    transformFs().chmod(path, mode);
  } catch (error) {
    throw new Error(`Failed to restrict permissions for ${path}: ${errorText(error)}`);
  }
}

/** 在会话 temp root 下创建一次性 job 目录并写入输入快照与脚本正文。 */
export function prepareTransformJob(
  tempRoot: string, script: NormalizedTransformScript, input: unknown,
): PreparedTransformJob {
  const millis = Date.now();
  const seq = jobSeq;
  jobSeq += 1;
  const relative = `chatanki_transform/job-${millis}-${String(seq).padStart(4, '0')}`;
  const created = join(tempRoot, relative);
  try {
    transformFs().mkdir(created, 0o700);
  } catch (error) {
    throw new Error(`Failed to create transform job directory: ${errorText(error)}`);
  }
  // temp root 可能位于符号链接路径下（macOS /var → /private/var）；沙箱策略按
  // 字面路径匹配，必须先用真实 vnode 路径。
  const jobDir = transformFs().realpath(created) ?? created;
  // 快照含未截断全文，且 job 会保留用于审计：目录先收紧到 owner-only 再建文件。
  setPrivateJobPermissions(jobDir, 0o700);

  const inputPath = join(jobDir, CHATANKI_INPUT_FILE);
  const outputPath = join(jobDir, CHATANKI_OUTPUT_FILE);
  const scriptPath = join(jobDir, scriptFileName(script.language));

  const inputBytes = utf8Encode(JSON.stringify(input));
  try {
    transformFs().writeFile(inputPath, inputBytes, 0o600);
  } catch (error) {
    throw new Error(`Failed to write ${CHATANKI_INPUT_FILE}: ${errorText(error)}`);
  }
  try {
    transformFs().writeFile(scriptPath, utf8Encode(script.code), 0o600);
  } catch (error) {
    throw new Error(`Failed to write transform script file: ${errorText(error)}`);
  }
  setPrivateJobPermissions(inputPath, 0o600);
  setPrivateJobPermissions(scriptPath, 0o600);

  return { jobDir, inputPath, outputPath, scriptPath, jobRef: `runtime-root://temp/${relative}` };
}

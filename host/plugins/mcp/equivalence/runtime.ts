/**
 * Which executable runs the stdio fixture as plain Node.
 *
 * Under `npm run test:host:electron` (and inside the Electron app) `process.execPath` is the
 * Electron binary. The MCP spawners clear the child environment (Rust `env_clear` +
 * minimal keys, TS `stdio-proxy.ts` likewise), so `ELECTRON_RUN_AS_NODE` from the parent
 * does not reach the child and `<electron> script.ts` starts the GUI app instead of the
 * server. The descriptor therefore names a runtime that is Node by construction:
 *   1. `config.nodeCommand` when given (must support type stripping);
 *   2. `process.execPath` when the current process is not Electron;
 *   3. the first `node` on PATH whose `process.features.typescript` is set;
 *   4. otherwise Electron with `ELECTRON_RUN_AS_NODE=1` put into the approved env, so the
 *      variable is part of the entry both backends validate and pass through.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export type RuntimeKind = 'explicit' | 'node-execpath' | 'node-path' | 'electron-as-node';

export interface StdioRuntime {
  /** Canonical absolute path (Rust validation compares canonical executables). */
  command: string;
  /** Extra env that must be part of the approved entry and the start request. */
  env: Record<string, string>;
  kind: RuntimeKind;
  /** `process.versions.node` of the chosen runtime. */
  nodeVersion: string;
}

export interface RuntimeProbeInput {
  execPath: string;
  isElectron: boolean;
  pathEnv: string;
  nodeCommand?: string | null;
}

function probe(command: string, env: Record<string, string>): { node: string; typescript: boolean } | null {
  const run = spawnSync(command, ['-e', 'process.stdout.write(JSON.stringify({node:process.versions.node,ts:Boolean(process.features.typescript),electron:process.versions.electron??null}))'], {
    env: { ...env, PATH: process.env.PATH ?? '' }, encoding: 'utf8', timeout: 20_000, windowsHide: true,
  });
  if (run.status !== 0 || typeof run.stdout !== 'string') return null;
  let parsed: { node?: unknown; ts?: unknown; electron?: unknown };
  try { parsed = JSON.parse(run.stdout) as typeof parsed; }
  catch { return null; }
  // A binary that still reports Electron here did not run as Node.
  if (typeof parsed.node !== 'string' || (parsed.electron !== null && env.ELECTRON_RUN_AS_NODE === undefined)) return null;
  return { node: parsed.node, typescript: parsed.ts === true };
}

function executable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch { return false; }
}

function nodeOnPath(pathEnv: string): string[] {
  const names = process.platform === 'win32' ? ['node.exe', 'node.cmd'] : ['node'];
  const found: string[] = [];
  for (const directory of pathEnv.split(delimiter)) {
    if (directory.trim() === '') continue;
    for (const name of names) {
      const candidate = join(directory, name);
      if (executable(candidate)) found.push(realpathSync(candidate));
    }
  }
  return [...new Set(found)];
}

export function resolveStdioRuntime(input: RuntimeProbeInput): StdioRuntime {
  const tried: string[] = [];
  const accept = (command: string, env: Record<string, string>, kind: RuntimeKind): StdioRuntime | null => {
    const canonical = realpathSync(command);
    const info = probe(canonical, env);
    tried.push(`${kind}:${canonical}:${info === null ? 'not-node' : info.typescript ? `node ${info.node}` : `node ${info.node} without type stripping`}`);
    return info !== null && info.typescript ? { command: canonical, env, kind, nodeVersion: info.node } : null;
  };
  if (input.nodeCommand !== undefined && input.nodeCommand !== null) {
    const chosen = accept(input.nodeCommand, {}, 'explicit');
    if (chosen === null) throw new Error(`mcp equivalence: nodeCommand cannot run the TS fixture (${tried.join('; ')})`);
    return chosen;
  }
  if (!input.isElectron) {
    const chosen = accept(input.execPath, {}, 'node-execpath');
    if (chosen !== null) return chosen;
  }
  for (const candidate of nodeOnPath(input.pathEnv)) {
    const chosen = accept(candidate, {}, 'node-path');
    if (chosen !== null) return chosen;
  }
  if (input.isElectron) {
    const chosen = accept(input.execPath, { ELECTRON_RUN_AS_NODE: '1' }, 'electron-as-node');
    if (chosen !== null) return chosen;
  }
  throw new Error(`mcp equivalence: no Node runtime with type stripping found (${tried.join('; ') || 'no candidates'})`);
}

export function currentStdioRuntime(nodeCommand?: string | null): StdioRuntime {
  return resolveStdioRuntime({
    execPath: process.execPath,
    isElectron: typeof process.versions.electron === 'string',
    pathEnv: process.env.PATH ?? '',
    nodeCommand,
  });
}

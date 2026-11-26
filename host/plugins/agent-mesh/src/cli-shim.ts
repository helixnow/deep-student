/**
 * Ephemeral `PATH` CLI Shim Generator (`dstu-mesh`).
 *
 * Writes a zero-dependency executable `dstu-mesh` command (plus `dstu-mesh.cmd`
 * on Windows) into an ephemeral `bin` directory so ANY external coding CLI with
 * shell execution (including CLIs without dynamic HTTP MCP config flags) can
 * read/post to the Mesh board, consult peers, hand off tasks, claim/release file
 * leases, park at 0 tokens, and retrieve DeepStudent study context.
 *
 * Invokes Node's built-in `fetch` via `process.execPath` (`ELECTRON_RUN_AS_NODE=1`)
 * against `POST http://127.0.0.1:<port>/api/call` authenticated by `DSTU_MESH_TOKEN`.
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { normalizeMeshBridgeUrls } from './mesh-mcp-server.ts';

export interface CreateCliShimOptions {
  /** Optional explicit directory; creates a fresh mkdtemp directory if omitted. */
  binDir?: string;
  /** Optional override for the Node/Electron runtime binary (`process.execPath` by default). */
  nodeExecPath?: string;
}

export interface CreatedCliShim {
  binDir: string;
  posixScriptPath: string;
  windowsCmdPath: string;
  entryModulePath: string;
  executablePath: string;
}

export interface BuildCliShimEnvInput {
  shimBinDir: string;
  endpointUrl: string;
  token: string;
  baseEnv?: NodeJS.ProcessEnv;
}

function escapePosixDoubleQuoted(value: string): string {
  return value.replace(/(["\\$`])/g, '\\$1');
}

function renderCliEntryModuleSource(): string {
  return `// Auto-generated DeepStudent Agent Mesh CLI shim (zero external dependencies).
const SUBCOMMAND_TO_TOOL = {
  post: 'mesh_post_board',
  read: 'mesh_read_board',
  ask: 'mesh_ask_peer',
  handoff: 'mesh_handoff',
  claim: 'mesh_claim_files',
  release: 'mesh_release_files',
  park: 'mesh_park',
  context: 'study_read_context',
};

function writeOut(text) {
  process.stdout.write(text.endsWith('\\n') ? text : text + '\\n');
}

function writeErr(text) {
  process.stderr.write(text.endsWith('\\n') ? text : text + '\\n');
}

function printUsage() {
  writeOut([
    'Usage: dstu-mesh <subcommand> [options]',
    '',
    'Subcommands:',
    '  post <text...> [--mention @a,@b] [--channel <name>] [--reply-to <seq>]',
    '  read [--since <seq>] [--limit <n>]',
    '  ask <targetAgent> <question...> [--context <p1,p2>]',
    '  handoff <targetAgent> --summary <text> --next <task> [--files <f1,f2>]',
    '  claim <path1> [path2...] [--wait <ms>]',
    '  release [path1] [path2...]',
    '  park [summary...]',
    '  context <query...> [--resource <id>] [--max-chars <n>]',
  ].join('\\n'));
}

function parseFlagsAndPositionals(rawArgs) {
  const flags = new Map();
  const positionals = [];
  let literalRest = false;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (literalRest) {
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      literalRest = true;
      continue;
    }
    if (arg.startsWith('--') && arg.length > 2) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx > 2) {
        const key = arg.slice(2, eqIdx);
        const val = arg.slice(eqIdx + 1);
        const list = flags.get(key) ?? [];
        list.push(val);
        flags.set(key, list);
      } else {
        const key = arg.slice(2);
        const next = rawArgs[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          const list = flags.get(key) ?? [];
          list.push(next);
          flags.set(key, list);
          i++;
        } else {
          flags.set(key, ['true']);
        }
      }
      continue;
    }
    positionals.push(arg);
  }
  return { flags, positionals };
}

function firstFlag(flags, ...names) {
  for (const name of names) {
    const vals = flags.get(name);
    if (vals && vals.length > 0) return vals[vals.length - 1];
  }
  return undefined;
}

function splitListFlag(flags, ...names) {
  const collected = [];
  for (const name of names) {
    const vals = flags.get(name);
    if (!vals) continue;
    for (const v of vals) {
      for (const item of v.split(',')) {
        const trimmed = item.trim();
        if (trimmed) collected.push(trimmed);
      }
    }
  }
  return collected.length > 0 ? collected : undefined;
}

function parseOptionalInt(raw, label) {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    throw new Error('Invalid integer for ' + label + ': ' + raw);
  }
  return n;
}

function resolveApiCallUrl(rawUrl) {
  const trimmed = rawUrl.trim().replace(/\\/+$/, '');
  if (trimmed.endsWith('/api/call')) return trimmed;
  if (trimmed.endsWith('/mcp')) return trimmed.slice(0, -4) + '/api/call';
  return trimmed + '/api/call';
}

function buildToolPayload(subcommand, restArgs) {
  const tool = SUBCOMMAND_TO_TOOL[subcommand];
  if (!tool) {
    throw new Error('Unknown subcommand "' + subcommand + '". Expected one of: ' + Object.keys(SUBCOMMAND_TO_TOOL).join(', '));
  }
  const { flags, positionals } = parseFlagsAndPositionals(restArgs);

  switch (subcommand) {
    case 'post': {
      const text = firstFlag(flags, 'text', 'message') ?? positionals.join(' ').trim();
      if (!text) throw new Error('dstu-mesh post requires message text');
      const mentions = splitListFlag(flags, 'mention', 'mentions');
      const channel = firstFlag(flags, 'channel');
      const replyToSeq = parseOptionalInt(firstFlag(flags, 'reply-to', 'replyToSeq'), '--reply-to');
      const args = { text };
      if (mentions) args.mentions = mentions;
      if (channel !== undefined) args.channel = channel;
      if (replyToSeq !== undefined) args.replyToSeq = replyToSeq;
      return { tool, args };
    }

    case 'read': {
      const sinceRaw = firstFlag(flags, 'since', 'since-seq', 'sinceSeq') ?? positionals[0];
      const limitRaw = firstFlag(flags, 'limit') ?? positionals[1];
      const sinceSeq = parseOptionalInt(sinceRaw, '--since');
      const limit = parseOptionalInt(limitRaw, '--limit');
      const args = {};
      if (sinceSeq !== undefined) args.sinceSeq = sinceSeq;
      if (limit !== undefined) args.limit = limit;
      return { tool, args };
    }

    case 'ask': {
      const targetAgent = firstFlag(flags, 'target', 'to', 'targetAgent') ?? positionals[0];
      const question = firstFlag(flags, 'question') ?? (firstFlag(flags, 'target', 'to', 'targetAgent') ? positionals.join(' ') : positionals.slice(1).join(' ')).trim();
      if (!targetAgent || !question) {
        throw new Error('Usage: dstu-mesh ask <targetAgent> <question...> [--context p1,p2]');
      }
      const contextPaths = splitListFlag(flags, 'context', 'context-paths', 'contextPaths');
      const args = { targetAgent, question };
      if (contextPaths) args.contextPaths = contextPaths;
      return { tool, args };
    }

    case 'handoff': {
      const targetFlag = firstFlag(flags, 'target', 'to', 'targetAgent');
      const targetAgent = targetFlag ?? positionals[0];
      const posOffset = targetFlag ? 0 : 1;
      const summary = firstFlag(flags, 'summary') ?? positionals[posOffset];
      const nextTask = firstFlag(flags, 'next', 'next-task', 'nextTask') ?? positionals.slice(posOffset + 1).join(' ').trim();
      if (!targetAgent || !summary || !nextTask) {
        throw new Error('Usage: dstu-mesh handoff <targetAgent> --summary <summary> --next <nextTask> [--files f1,f2]');
      }
      const changedFiles = splitListFlag(flags, 'files', 'changed-files', 'changedFiles');
      const args = { targetAgent, summary, nextTask };
      if (changedFiles) args.changedFiles = changedFiles;
      return { tool, args };
    }

    case 'claim': {
      const flagPaths = splitListFlag(flags, 'paths', 'path') ?? [];
      const posPaths = [];
      for (const p of positionals) {
        for (const item of p.split(',')) {
          const trimmed = item.trim();
          if (trimmed) posPaths.push(trimmed);
        }
      }
      const paths = [...flagPaths, ...posPaths];
      if (paths.length === 0) {
        throw new Error('Usage: dstu-mesh claim <path1> [path2...] [--wait <ms>]');
      }
      const waitMs = parseOptionalInt(firstFlag(flags, 'wait', 'wait-ms', 'waitMs'), '--wait');
      const args = { paths };
      if (waitMs !== undefined) args.waitMs = waitMs;
      return { tool, args };
    }

    case 'release': {
      const flagPaths = splitListFlag(flags, 'paths', 'path') ?? [];
      const posPaths = [];
      for (const p of positionals) {
        for (const item of p.split(',')) {
          const trimmed = item.trim();
          if (trimmed) posPaths.push(trimmed);
        }
      }
      const paths = [...flagPaths, ...posPaths];
      const args = paths.length > 0 ? { paths } : {};
      return { tool, args };
    }

    case 'park': {
      const summary = firstFlag(flags, 'summary') ?? (positionals.length > 0 ? positionals.join(' ').trim() : undefined);
      const args = summary ? { summary } : {};
      return { tool, args };
    }

    case 'context': {
      const query = firstFlag(flags, 'query', 'q') ?? positionals.join(' ').trim();
      const resourceId = firstFlag(flags, 'resource', 'resource-id', 'resourceId');
      const maxChars = parseOptionalInt(firstFlag(flags, 'max-chars', 'maxChars'), '--max-chars');
      const effectiveQuery = query || (resourceId ?? '');
      if (!effectiveQuery) {
        throw new Error('Usage: dstu-mesh context <query...> [--resource <id>] [--max-chars <n>]');
      }
      const args = { query: effectiveQuery };
      if (resourceId !== undefined) args.resourceId = resourceId;
      if (maxChars !== undefined) args.maxChars = maxChars;
      return { tool, args };
    }

    default:
      throw new Error('Unsupported subcommand: ' + subcommand);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    printUsage();
    process.exit(argv.length === 0 ? 1 : 0);
  }

  const rawUrl = process.env.DSTU_MESH_API_URL || process.env.DSTU_MESH_URL || '';
  const token = process.env.DSTU_MESH_TOKEN || '';
  if (!rawUrl || !token) {
    writeErr('dstu-mesh error: DSTU_MESH_URL and DSTU_MESH_TOKEN environment variables are required.');
    process.exit(2);
  }

  let payload;
  try {
    payload = buildToolPayload(argv[0], argv.slice(1));
  } catch (err) {
    writeErr('dstu-mesh argument error: ' + (err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  const endpoint = resolveApiCallUrl(rawUrl);
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    writeErr('dstu-mesh transport error: ' + (err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  const rawText = await response.text();
  let parsed = null;
  try {
    parsed = rawText ? JSON.parse(rawText) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok || (parsed && parsed.ok === false)) {
    const errMsg = (parsed && typeof parsed.error === 'string' && parsed.error) || rawText || ('HTTP ' + response.status);
    writeErr('dstu-mesh error (' + response.status + '): ' + errMsg);
    process.exit(response.status === 401 ? 2 : 1);
  }

  const outputValue = parsed && Object.prototype.hasOwnProperty.call(parsed, 'result') ? parsed.result : parsed;
  writeOut(JSON.stringify(outputValue, null, 2));
}

main();
`;
}

/**
 * Writes `dstu-mesh` (POSIX `+x`), `dstu-mesh.cmd` (Windows), and `dstu-mesh-cli.mjs`
 * into an ephemeral `bin` directory.
 */
export async function createCliShim(options?: CreateCliShimOptions): Promise<CreatedCliShim> {
  const binDir = options?.binDir
    ? path.resolve(options.binDir)
    : await fsp.mkdtemp(path.join(os.tmpdir(), 'dstu-mesh-bin-'));
  await fsp.mkdir(binDir, { recursive: true });

  const nodeExecPath = options?.nodeExecPath ?? process.execPath;
  const entryModulePath = path.join(binDir, 'dstu-mesh-cli.mjs');
  const posixScriptPath = path.join(binDir, 'dstu-mesh');
  const windowsCmdPath = path.join(binDir, 'dstu-mesh.cmd');

  await fsp.writeFile(entryModulePath, renderCliEntryModuleSource(), {
    encoding: 'utf8',
    mode: 0o644,
  });

  const posixWrapper =
    `#!/bin/sh\n` +
    `ELECTRON_RUN_AS_NODE=1 exec "${escapePosixDoubleQuoted(nodeExecPath)}" "${escapePosixDoubleQuoted(entryModulePath)}" "$@"\n`;
  await fsp.writeFile(posixScriptPath, posixWrapper, {
    encoding: 'utf8',
    mode: 0o755,
  });
  await fsp.chmod(posixScriptPath, 0o755);

  const windowsWrapper =
    `@echo off\r\n` +
    `set ELECTRON_RUN_AS_NODE=1\r\n` +
    `"${nodeExecPath}" "${entryModulePath}" %*\r\n`;
  await fsp.writeFile(windowsCmdPath, windowsWrapper, {
    encoding: 'utf8',
    mode: 0o755,
  });

  return {
    binDir,
    posixScriptPath,
    windowsCmdPath,
    entryModulePath,
    executablePath: process.platform === 'win32' ? windowsCmdPath : posixScriptPath,
  };
}

/**
 * Synchronous variant of `createCliShim` for adapter startup paths that build spawn plans synchronously.
 */
export function createCliShimSync(options?: CreateCliShimOptions): CreatedCliShim {
  const binDir = options?.binDir
    ? path.resolve(options.binDir)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'dstu-mesh-bin-'));
  fs.mkdirSync(binDir, { recursive: true });

  const nodeExecPath = options?.nodeExecPath ?? process.execPath;
  const entryModulePath = path.join(binDir, 'dstu-mesh-cli.mjs');
  const posixScriptPath = path.join(binDir, 'dstu-mesh');
  const windowsCmdPath = path.join(binDir, 'dstu-mesh.cmd');

  fs.writeFileSync(entryModulePath, renderCliEntryModuleSource(), {
    encoding: 'utf8',
    mode: 0o644,
  });

  const posixWrapper =
    `#!/bin/sh\n` +
    `ELECTRON_RUN_AS_NODE=1 exec "${escapePosixDoubleQuoted(nodeExecPath)}" "${escapePosixDoubleQuoted(entryModulePath)}" "$@"\n`;
  fs.writeFileSync(posixScriptPath, posixWrapper, {
    encoding: 'utf8',
    mode: 0o755,
  });
  fs.chmodSync(posixScriptPath, 0o755);

  const windowsWrapper =
    `@echo off\r\n` +
    `set ELECTRON_RUN_AS_NODE=1\r\n` +
    `"${nodeExecPath}" "${entryModulePath}" %*\r\n`;
  fs.writeFileSync(windowsCmdPath, windowsWrapper, {
    encoding: 'utf8',
    mode: 0o755,
  });

  return {
    binDir,
    posixScriptPath,
    windowsCmdPath,
    entryModulePath,
    executablePath: process.platform === 'win32' ? windowsCmdPath : posixScriptPath,
  };
}

/**
 * Builds child-process environment variables with `shimBinDir` prepended to `PATH`
 * (preserving Windows `Path` key casing if present) plus `DSTU_MESH_URL` and `DSTU_MESH_TOKEN`.
 */
export function buildCliShimEnv(input: BuildCliShimEnvInput): NodeJS.ProcessEnv {
  const base = input.baseEnv ?? process.env;
  const env: NodeJS.ProcessEnv = { ...base };
  const { baseUrl, mcpEndpointUrl, apiEndpointUrl } = normalizeMeshBridgeUrls(input.endpointUrl);

  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const existingPath = env[pathKey] ?? '';
  const combinedPath = existingPath
    ? `${input.shimBinDir}${path.delimiter}${existingPath}`
    : input.shimBinDir;

  env[pathKey] = combinedPath;
  if (pathKey !== 'PATH') {
    env.PATH = combinedPath;
  }
  env.DSTU_MESH_URL = baseUrl;
  env.DSTU_MESH_MCP_URL = mcpEndpointUrl;
  env.DSTU_MESH_API_URL = apiEndpointUrl;
  env.DSTU_MESH_TOKEN = input.token;
  return env;
}

export async function removeCliShim(shimOrDir: string | CreatedCliShim): Promise<void> {
  const dir = typeof shimOrDir === 'string' ? shimOrDir : shimOrDir.binDir;
  await fsp.rm(dir, { recursive: true, force: true });
}

// Silent non-blocking CLI capability prober for Agent Mesh.
// Detects PATH installation, semantic version, auth hints, and protocol capabilities
// for claude, codex, opencode, pi, agy, dsh, and user-defined custom CLI templates.

import { spawn as nodeSpawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AdapterCapabilities,
  CliAuthStatus,
  CustomCliTemplate,
  DetectedCliAgent,
  ExternalAgentDriverKind,
} from './adapter-types.ts';

export const DEFAULT_PROBE_TTL_MS = 30_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 3_500;
const MAX_PROBE_OUTPUT_BYTES = 16_384;

export interface ProbeCommandOptions {
  readonly timeoutMs: number;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface ProbeCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly notFound?: boolean;
  readonly timedOut?: boolean;
  readonly resolvedPath?: string | null;
}

export type ProbeCommandRunner = (
  command: string,
  args: readonly string[],
  options: ProbeCommandOptions,
) => Promise<ProbeCommandResult>;

export type FileExistsPort = (filePath: string) => Promise<boolean>;
export type ReadTextFilePort = (filePath: string) => Promise<string | null>;

export interface CliProberOptions {
  readonly ttlMs?: number;
  readonly timeoutMs?: number;
  readonly commandRunner?: ProbeCommandRunner;
  readonly fileExists?: FileExistsPort;
  readonly readTextFile?: ReadTextFilePort;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
}

export interface ProbeAllInput {
  readonly forceRefresh?: boolean;
  readonly customTemplates?: readonly CustomCliTemplate[];
}

interface BuiltInCliDescriptor {
  readonly id: Exclude<ExternalAgentDriverKind, 'custom'>;
  readonly displayName: string;
  readonly command: string;
  readonly versionArgs: readonly string[];
  readonly capabilities: AdapterCapabilities;
}

export const DRIVER_DEFAULT_CAPABILITIES: Readonly<
  Record<ExternalAgentDriverKind, AdapterCapabilities>
> = {
  claude: {
    streamingEvents: true,
    midTurnSteer: true,
    interrupt: true,
    approvalCallback: true,
    sessionResume: true,
    sessionFork: true,
    nativeSubagentTree: true,
    backgroundTaskEvents: true,
    mcpInjection: true,
  },
  codex: {
    streamingEvents: true,
    midTurnSteer: true,
    interrupt: true,
    approvalCallback: true,
    sessionResume: true,
    sessionFork: false,
    nativeSubagentTree: true,
    backgroundTaskEvents: true,
    mcpInjection: true,
  },
  opencode: {
    streamingEvents: true,
    midTurnSteer: false,
    interrupt: true,
    approvalCallback: false,
    sessionResume: true,
    sessionFork: false,
    nativeSubagentTree: true,
    backgroundTaskEvents: false,
    mcpInjection: true,
  },
  pi: {
    streamingEvents: true,
    midTurnSteer: true,
    interrupt: true,
    approvalCallback: true,
    sessionResume: true,
    sessionFork: false,
    nativeSubagentTree: true,
    backgroundTaskEvents: true,
    mcpInjection: true,
  },
  agy: {
    streamingEvents: true,
    midTurnSteer: false,
    interrupt: true,
    approvalCallback: false,
    sessionResume: true,
    sessionFork: false,
    nativeSubagentTree: false,
    backgroundTaskEvents: false,
    mcpInjection: true,
  },
  dsh: {
    streamingEvents: true,
    midTurnSteer: false,
    interrupt: true,
    approvalCallback: false,
    sessionResume: true,
    sessionFork: false,
    nativeSubagentTree: false,
    backgroundTaskEvents: false,
    mcpInjection: true,
  },
  custom: {
    streamingEvents: true,
    midTurnSteer: false,
    interrupt: true,
    approvalCallback: false,
    sessionResume: false,
    sessionFork: false,
    nativeSubagentTree: false,
    backgroundTaskEvents: false,
    mcpInjection: true,
  },
};

const BUILT_IN_DESCRIPTORS: readonly BuiltInCliDescriptor[] = [
  {
    id: 'claude',
    displayName: 'Claude Code',
    command: 'claude',
    versionArgs: ['--version'],
    capabilities: DRIVER_DEFAULT_CAPABILITIES.claude,
  },
  {
    id: 'codex',
    displayName: 'Codex CLI',
    command: 'codex',
    versionArgs: ['--version'],
    capabilities: DRIVER_DEFAULT_CAPABILITIES.codex,
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    command: 'opencode',
    versionArgs: ['--version'],
    capabilities: DRIVER_DEFAULT_CAPABILITIES.opencode,
  },
  {
    id: 'pi',
    displayName: 'Pi Agent',
    command: 'pi',
    versionArgs: ['--version'],
    capabilities: DRIVER_DEFAULT_CAPABILITIES.pi,
  },
  {
    id: 'agy',
    displayName: 'Antigravity CLI',
    command: 'agy',
    versionArgs: ['--version'],
    capabilities: DRIVER_DEFAULT_CAPABILITIES.agy,
  },
  {
    id: 'dsh',
    displayName: 'DeepSeek Harness',
    command: 'dsh',
    versionArgs: ['--version'],
    capabilities: DRIVER_DEFAULT_CAPABILITIES.dsh,
  },
];

export const DRIVER_CURATED_MODELS: Readonly<
  Record<Exclude<ExternalAgentDriverKind, 'custom'>, readonly string[]>
> = {
  claude: [
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-fable-5-2',
    'claude-haiku-5-5',
    'claude-fable-5-1',
    'claude-fable-5',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'fable',
    'opus',
    'sonnet',
    'haiku',
  ],
  codex: [
    'gpt-6.2-sol',
    'gpt-6.2-astra',
    'gpt-6.1-terra',
    'gpt-6.1-sol',
    'gpt-6-astra',
    'gpt-6-sol',
    'gpt-6-luna',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
  ],
  opencode: [
    'opencode-go/gpt-6-luna',
    'opencode-go/gemini-4-argon',
    'opencode-go/deepseek-v4-pro',
    'opencode-go/claude-haiku-5-5',
    'opencode-go/glm-5.3',
    'opencode-go/kimi-k3.1-pro',
  ],
  pi: [
    'claude-sonnet-5-5',
    'claude-opus-5-5',
    'gpt-6.2-sol',
    'gemini-4-neon-high',
    'deepseek-v4-pro',
  ],
  agy: [
    'gemini-4-neon-high',
    'gemini-4-neon-medium',
    'gemini-4-carbon-high',
    'gemini-4-argon-medium',
    'gemini-4-hydrogen-high',
    'gemini-3.8-flash-high',
    'claude-opus-5-5-high',
    'claude-sonnet-5-5-high',
  ],
  dsh: [
    'deepseek-v4-pro',
    'deepseek-v4.1-flash',
    'deepseek-v4-flash',
    'deepseek-reasoner',
    'deepseek-chat',
  ],
};

const ANSI_CSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g');

function stripAnsiAndSpinnerNoise(raw: string): string {
  return raw
    .replace(ANSI_CSI_PATTERN, '')
    .replace(/[\u2800-\u28ff]/g, '')
    .replace(/\r/g, '\n');
}

export function parseAgyModelsOutput(rawOutput: string): string[] {
  const cleaned = stripAnsiAndSpinnerNoise(rawOutput);
  const models: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of cleaned.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(fetching available models|usage:|available models|flags:|error:|-h\b|--help\b)/i.test(line)) {
      continue;
    }
    const tableMatch = line.match(/^([a-z0-9][a-z0-9._/-]{1,80})(?:(?:\t+|\s{2,}).+)?$/i);
    if (!tableMatch) continue;
    const id = tableMatch[1]!.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push(id);
  }
  return models;
}

export function parseOpenCodeModelsOutput(rawOutput: string): string[] {
  const cleaned = stripAnsiAndSpinnerNoise(rawOutput);
  const models: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of cleaned.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(fetching|loading|usage:|error:|warn)/i.test(line)) continue;
    // OpenCode outputs `provider/model-id` per line
    if (/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i.test(line)) {
      if (!seen.has(line)) {
        seen.add(line);
        models.push(line);
      }
    }
  }
  return models;
}

export function parsePiListModelsOutput(rawOutput: string): string[] {
  const cleaned = stripAnsiAndSpinnerNoise(rawOutput);
  const models: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of cleaned.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(no models available|use \/login|usage:|error:|http|\/)/i.test(line)) continue;
    const tokenMatch = line.match(/^([a-z0-9][a-z0-9._/-]{2,90})(?:\s+.+)?$/i);
    if (!tokenMatch) continue;
    const candidate = tokenMatch[1]!.trim();
    if (!candidate.includes('-') && !candidate.includes('/')) continue;
    if (!seen.has(candidate)) {
      seen.add(candidate);
      models.push(candidate);
    }
  }
  return models;
}

export function parseCodexModelsCacheJson(rawJson: string): string[] {
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).models)
        ? ((parsed as Record<string, unknown>).models as unknown[])
        : [];

    const entries: Array<{ slug: string; priority: number }> = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      if (rec.visibility === 'hide') continue;
      const slug =
        (typeof rec.slug === 'string' && rec.slug.trim()) ||
        (typeof rec.id === 'string' && rec.id.trim()) ||
        (typeof rec.model === 'string' && rec.model.trim()) ||
        '';
      if (!slug) continue;
      const priority = typeof rec.priority === 'number' && Number.isFinite(rec.priority) ? rec.priority : 9_999;
      entries.push({ slug, priority });
    }

    entries.sort((a, b) => a.priority - b.priority);
    const seen = new Set<string>();
    const result: string[] = [];
    for (const entry of entries) {
      if (!seen.has(entry.slug)) {
        seen.add(entry.slug);
        result.push(entry.slug);
      }
    }
    return result;
  } catch {
    return [];
  }
}

async function defaultFileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch (err) {
    return err instanceof Error ? false : false;
  }
}

async function defaultReadTextFile(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > 4_194_304) return null;
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function isExecutableFile(
  candidatePath: string,
  platform: NodeJS.Platform,
): Promise<boolean> {
  try {
    const stat = await fs.stat(candidatePath);
    if (!stat.isFile()) return false;
    if (platform === 'win32') return true;
    await fs.access(candidatePath, fsConstants.X_OK);
    return true;
  } catch (err) {
    return err instanceof Error ? false : false;
  }
}

export function buildStandardPosixBinDirs(homeDir?: string): string[] {
  const trimmedHome = homeDir?.trim() ?? '';
  return [
    ...(trimmedHome
      ? [
          path.posix.join(trimmedHome, '.local', 'bin'),
          path.posix.join(trimmedHome, '.grok', 'bin'),
          path.posix.join(trimmedHome, '.bun', 'bin'),
          path.posix.join(trimmedHome, '.cargo', 'bin'),
        ]
      : []),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
  ];
}

export function augmentPosixUserPath(
  rawPath: string | undefined,
  homeDir: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    return rawPath ?? '';
  }
  const segments = (rawPath ?? '').split(':').filter((seg) => seg.length > 0);
  const seen = new Set(segments);
  for (const extraDir of buildStandardPosixBinDirs(homeDir)) {
    if (!seen.has(extraDir)) {
      seen.add(extraDir);
      segments.push(extraDir);
    }
  }
  return segments.join(':');
}

export function augmentEnvWithPosixUserPath(
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string = env.HOME ?? os.homedir(),
  platform: NodeJS.Platform = process.platform,
): Record<string, string | undefined> {
  if (platform === 'win32') {
    return { ...env };
  }
  const next: Record<string, string | undefined> = { ...env };
  const pathKey = Object.keys(next).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  next[pathKey] = augmentPosixUserPath(next[pathKey], homeDir, platform);
  return next;
}

export async function resolveExecutableOnPath(
  command: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const trimmed = command.trim();
  if (!trimmed) return null;

  const hasSeparator = trimmed.includes('/') || (platform === 'win32' && trimmed.includes('\\'));
  const pathExtensions =
    platform === 'win32'
      ? (env.PATHEXT ?? env.PathExt ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter((ext) => ext.length > 0)
      : [''];

  const candidatesForBase = (base: string): string[] => {
    if (platform !== 'win32') return [base];
    const ext = path.win32.extname(base);
    if (ext.length > 0) return [base];
    return [base, ...pathExtensions.map((suffix) => `${base}${suffix.toLowerCase()}`), ...pathExtensions.map((suffix) => `${base}${suffix.toUpperCase()}`)];
  };

  if (hasSeparator) {
    for (const candidate of candidatesForBase(trimmed)) {
      if (await isExecutableFile(candidate, platform)) {
        return candidate;
      }
    }
    return null;
  }

  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  const rawPath = pathKey ? (env[pathKey] ?? '') : '';
  const effectivePath =
    platform === 'win32'
      ? rawPath
      : augmentPosixUserPath(rawPath, env.HOME ?? os.homedir(), platform);
  const delimiter = platform === 'win32' ? ';' : ':';
  const dirs = effectivePath.split(delimiter).filter((dir) => dir.length > 0);

  for (const dir of dirs) {
    const joined = platform === 'win32' ? path.win32.join(dir, trimmed) : path.posix.join(dir, trimmed);
    for (const candidate of candidatesForBase(joined)) {
      if (await isExecutableFile(candidate, platform)) {
        return candidate;
      }
    }
  }

  return null;
}

export function createDefaultProbeCommandRunner(
  platform: NodeJS.Platform = process.platform,
): ProbeCommandRunner {
  return async (command, args, options): Promise<ProbeCommandResult> => {
    const augmentedEnv = augmentEnvWithPosixUserPath(
      options.env,
      options.env.HOME ?? os.homedir(),
      platform,
    );
    const resolvedPath = await resolveExecutableOnPath(command, augmentedEnv, platform);
    if (!resolvedPath) {
      return {
        exitCode: null,
        stdout: '',
        stderr: '',
        notFound: true,
        resolvedPath: null,
      };
    }

    const cleanEnv: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(augmentedEnv)) {
      if (v !== undefined) cleanEnv[k] = v;
    }
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;
    delete cleanEnv.NODE_OPTIONS;
    cleanEnv.CI = '1';
    cleanEnv.NO_COLOR = '1';

    const isWinBatch =
      platform === 'win32' &&
      (resolvedPath.toLowerCase().endsWith('.cmd') || resolvedPath.toLowerCase().endsWith('.bat'));
    const spawnFile = isWinBatch
      ? path.win32.join(cleanEnv.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
      : resolvedPath;
    const spawnArgs = isWinBatch
      ? ['/d', '/s', '/c', `"${[`"${resolvedPath}"`, ...args].join(' ')}"`]
      : [...args];

    return new Promise<ProbeCommandResult>((resolve) => {
      let settled = false;
      let timedOut = false;
      let stdout = '';
      let stderr = '';

      const finish = (result: ProbeCommandResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      let child: ReturnType<typeof nodeSpawn>;
      try {
        child = nodeSpawn(spawnFile, spawnArgs, {
          env: cleanEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          windowsVerbatimArguments: isWinBatch,
        });
      } catch (err) {
        const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: unknown }).code) : '';
        finish({
          exitCode: null,
          stdout: '',
          stderr: err instanceof Error ? err.message : String(err),
          notFound: code === 'ENOENT' || code === 'EACCES',
          resolvedPath: null,
        });
        return;
      }

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch (err) {
          if (err instanceof Error) {
            // Process already exited while timer fired.
          }
        }
      }, Math.max(100, options.timeoutMs));
      timer.unref?.();

      child.stdout?.on('data', (chunk: Buffer | string) => {
        if (stdout.length < MAX_PROBE_OUTPUT_BYTES) {
          stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        }
      });

      child.stderr?.on('data', (chunk: Buffer | string) => {
        if (stderr.length < MAX_PROBE_OUTPUT_BYTES) {
          stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        }
      });

      child.once('error', (err) => {
        clearTimeout(timer);
        const code = 'code' in err ? String((err as NodeJS.ErrnoException).code) : '';
        finish({
          exitCode: null,
          stdout,
          stderr: err.message,
          notFound: code === 'ENOENT' || code === 'EACCES',
          timedOut,
          resolvedPath: code === 'ENOENT' ? null : resolvedPath,
        });
      });

      child.once('close', (exitCode) => {
        clearTimeout(timer);
        finish({
          exitCode,
          stdout,
          stderr,
          timedOut,
          resolvedPath,
        });
      });
    });
  };
}

export function extractSemanticVersion(rawOutput: string): string | null {
  const cleaned = rawOutput.trim();
  if (!cleaned) return null;
  const semverMatch = /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/u.exec(cleaned);
  if (semverMatch?.[1]) {
    return semverMatch[1];
  }
  const firstLine = cleaned.split(/\r?\n/u)[0]?.trim() ?? '';
  return firstLine.length > 0 && firstLine.length <= 64 ? firstLine : null;
}

function hasNonEmptyEnv(
  env: Readonly<Record<string, string | undefined>>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const val = env[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      return key;
    }
  }
  return null;
}

function fingerprintTemplates(templates: readonly CustomCliTemplate[]): string {
  if (templates.length === 0) return '';
  return templates
    .map((t) => `${t.id}:${t.name}:${t.command}:${(t.resumeArgsTemplate ?? []).length}`)
    .join('|');
}

export class CliAgentProber {
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly commandRunner: ProbeCommandRunner;
  private readonly fileExists: FileExistsPort;
  private readonly readTextFile: ReadTextFilePort;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly homeDir: string;
  private readonly now: () => number;

  private cachedResult: {
    readonly key: string;
    readonly expiresAt: number;
    readonly agents: readonly DetectedCliAgent[];
  } | null = null;
  private inflight: {
    readonly key: string;
    readonly promise: Promise<DetectedCliAgent[]>;
  } | null = null;

  constructor(options: CliProberOptions = {}) {
    const platform = options.platform ?? process.platform;
    this.ttlMs = options.ttlMs ?? DEFAULT_PROBE_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.commandRunner = options.commandRunner ?? createDefaultProbeCommandRunner(platform);
    this.fileExists = options.fileExists ?? defaultFileExists;
    this.readTextFile = options.readTextFile ?? defaultReadTextFile;
    this.homeDir = options.homeDir ?? os.homedir();
    this.env = augmentEnvWithPosixUserPath(options.env ?? process.env, this.homeDir, platform);
    this.now = options.now ?? Date.now;
  }

  invalidateCache(): void {
    this.cachedResult = null;
  }

  getCachedAgent(id: string): DetectedCliAgent | undefined {
    const cleanId = id.trim().replace(/^@+/, '');
    if (!cleanId || !this.cachedResult) return undefined;
    const found = this.cachedResult.agents.find((agent) => agent.id === cleanId);
    if (!found) return undefined;
    return {
      ...found,
      capabilities: { ...found.capabilities },
    };
  }

  async probeAll(input: ProbeAllInput = {}): Promise<DetectedCliAgent[]> {
    const templates = input.customTemplates ?? [];
    const cacheKey = fingerprintTemplates(templates);
    const currentTime = this.now();

    if (
      !input.forceRefresh &&
      this.cachedResult &&
      this.cachedResult.key === cacheKey &&
      currentTime < this.cachedResult.expiresAt
    ) {
      return [...this.cachedResult.agents];
    }

    if (!input.forceRefresh && this.inflight && this.inflight.key === cacheKey) {
      return this.inflight.promise;
    }

    const promise = this.executeProbeAll(templates).finally(() => {
      if (this.inflight?.promise === promise) {
        this.inflight = null;
      }
    });
    this.inflight = { key: cacheKey, promise };
    return promise;
  }

  private async executeProbeAll(
    customTemplates: readonly CustomCliTemplate[],
  ): Promise<DetectedCliAgent[]> {
    const builtInPromises = BUILT_IN_DESCRIPTORS.map((desc) => this.probeBuiltIn(desc));
    const customPromises = customTemplates.map((tpl) => this.probeCustomTemplate(tpl));
    const agents = await Promise.all([...builtInPromises, ...customPromises]);

    const cacheKey = fingerprintTemplates(customTemplates);
    this.cachedResult = {
      key: cacheKey,
      expiresAt: this.now() + Math.max(0, this.ttlMs),
      agents,
    };
    return [...agents];
  }

  private async safeRun(command: string, args: readonly string[], timeoutMs = this.timeoutMs): Promise<ProbeCommandResult> {
    try {
      return await this.commandRunner(command, args, {
        timeoutMs,
        env: this.env,
      });
    } catch (err) {
      return {
        exitCode: null,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        notFound: true,
        resolvedPath: null,
      };
    }
  }

  private async probeBuiltIn(desc: BuiltInCliDescriptor): Promise<DetectedCliAgent> {
    const probedAt = this.now();
    const res = await this.safeRun(desc.command, desc.versionArgs);
    const combinedOutput = `${res.stdout}\n${res.stderr}`.trim();
    const version = extractSemanticVersion(combinedOutput);
    const installed = !res.notFound && !res.timedOut && (res.exitCode === 0 || version !== null);

    if (!installed) {
      return {
        id: desc.id,
        driver: desc.id,
        displayName: desc.displayName,
        command: desc.command,
        resolvedPath: null,
        installed: false,
        version: null,
        authStatus: 'unknown',
        capabilities: { ...desc.capabilities },
        probedAt,
      };
    }

    const resolvedCmd = res.resolvedPath ?? desc.command;
    const [capabilities, auth, modelCatalog] = await Promise.all([
      this.detectRefinedCapabilities(desc),
      this.detectAuthHint(desc.id, desc.command),
      this.detectDriverModels(desc.id, desc.command),
    ]);

    return {
      id: desc.id,
      driver: desc.id,
      displayName: desc.displayName,
      command: desc.command,
      resolvedPath: resolvedCmd,
      installed: true,
      version,
      authStatus: auth.status,
      authHint: auth.hint,
      defaultModel: modelCatalog.defaultModel,
      availableModels: modelCatalog.availableModels,
      capabilities,
      probedAt,
    };
  }

  private async detectDriverModels(
    driver: Exclude<ExternalAgentDriverKind, 'custom'>,
    resolvedCommand: string,
  ): Promise<{ defaultModel: string | null; availableModels: string[] }> {
    let defaultModel: string | null = null;
    const liveModels: string[] = [];
    const configModels: string[] = [];

    const addLive = (value: unknown) => {
      if (typeof value !== 'string') return;
      const trimmed = value.trim();
      if (trimmed) liveModels.push(trimmed);
    };
    const addConfig = (value: unknown) => {
      if (typeof value !== 'string') return;
      const trimmed = value.trim();
      if (trimmed) configModels.push(trimmed);
    };

    try {
      if (driver === 'claude') {
        const envModel = this.env.ANTHROPIC_MODEL?.trim();
        if (envModel) {
          defaultModel = envModel;
          addConfig(envModel);
        }
        const rawSettings = await this.readTextFile(
          path.join(this.homeDir, '.claude', 'settings.json'),
        );
        if (rawSettings) {
          const parsed = JSON.parse(rawSettings) as Record<string, unknown>;
          const settingsEnv =
            parsed.env && typeof parsed.env === 'object'
              ? (parsed.env as Record<string, unknown>)
              : undefined;
          const configuredDefault =
            (typeof parsed.model === 'string' && parsed.model.trim()) ||
            (typeof settingsEnv?.ANTHROPIC_MODEL === 'string' && settingsEnv.ANTHROPIC_MODEL.trim()) ||
            null;
          if (!defaultModel && configuredDefault) {
            defaultModel = configuredDefault;
          }
          addConfig(parsed.model);
          if (parsed.modelSettings && typeof parsed.modelSettings === 'object') {
            for (const modelKey of Object.keys(parsed.modelSettings as Record<string, unknown>)) {
              addConfig(modelKey);
            }
          }
          addConfig(settingsEnv?.ANTHROPIC_MODEL);
          addConfig(settingsEnv?.ANTHROPIC_DEFAULT_OPUS_MODEL);
          addConfig(settingsEnv?.ANTHROPIC_DEFAULT_SONNET_MODEL);
          addConfig(settingsEnv?.ANTHROPIC_DEFAULT_HAIKU_MODEL);
          addConfig(settingsEnv?.ANTHROPIC_SMALL_FAST_MODEL);
        }
      } else if (driver === 'codex') {
        const [rawToml, rawCache, rawCcCatalog] = await Promise.all([
          this.readTextFile(path.join(this.homeDir, '.codex', 'config.toml')),
          this.readTextFile(path.join(this.homeDir, '.codex', 'models_cache.json')),
          this.readTextFile(path.join(this.homeDir, '.codex', 'cc-switch-model-catalog.json')),
        ]);
        if (rawToml) {
          const modelMatch = rawToml.match(/^\s*model\s*=\s*["']([^"'\r\n]+)["']/m);
          if (modelMatch?.[1]?.trim()) {
            defaultModel = modelMatch[1].trim();
            addConfig(defaultModel);
          }
        }
        if (rawCache) {
          for (const slug of parseCodexModelsCacheJson(rawCache)) {
            addLive(slug);
          }
        }
        if (liveModels.length === 0 && rawCcCatalog) {
          for (const slug of parseCodexModelsCacheJson(rawCcCatalog)) {
            addLive(slug);
          }
        }
      } else if (driver === 'opencode') {
        const xdgConfig = this.env.XDG_CONFIG_HOME || path.join(this.homeDir, '.config');
        const [rawJson, cliModelsRes] = await Promise.all([
          this.readTextFile(path.join(xdgConfig, 'opencode', 'opencode.json')),
          this.safeRun(resolvedCommand, ['models'], Math.min(4_000, this.timeoutMs + 1_000)),
        ]);
        if (rawJson) {
          const parsed = JSON.parse(rawJson) as Record<string, unknown>;
          if (typeof parsed.model === 'string' && parsed.model.trim()) {
            defaultModel = parsed.model.trim();
            addConfig(defaultModel);
          }
          if (typeof parsed.small_model === 'string' && parsed.small_model.trim()) {
            addConfig(parsed.small_model.trim());
          }
          if (parsed.provider && typeof parsed.provider === 'object') {
            for (const [providerId, providerVal] of Object.entries(
              parsed.provider as Record<string, unknown>,
            )) {
              if (!providerVal || typeof providerVal !== 'object') continue;
              const modelsObj = (providerVal as Record<string, unknown>).models;
              if (modelsObj && typeof modelsObj === 'object') {
                for (const modelKey of Object.keys(modelsObj as Record<string, unknown>)) {
                  if (modelKey.trim()) {
                    addConfig(`${providerId}/${modelKey.trim()}`);
                  }
                }
              }
            }
          }
        }
        if (!cliModelsRes.notFound && !cliModelsRes.timedOut && cliModelsRes.stdout) {
          for (const id of parseOpenCodeModelsOutput(cliModelsRes.stdout)) {
            addLive(id);
          }
        }
      } else if (driver === 'pi') {
        const [rawSettings, listRes] = await Promise.all([
          this.readTextFile(path.join(this.homeDir, '.pi', 'agent', 'settings.json')),
          this.safeRun(resolvedCommand, ['--list-models'], Math.min(3_500, this.timeoutMs)),
        ]);
        if (rawSettings) {
          const parsed = JSON.parse(rawSettings) as Record<string, unknown>;
          const configured =
            (typeof parsed.defaultModel === 'string' && parsed.defaultModel.trim()) ||
            (typeof parsed.model === 'string' && parsed.model.trim()) ||
            null;
          if (configured) {
            defaultModel = configured;
            addConfig(configured);
          }
        }
        if (!listRes.notFound && !listRes.timedOut && listRes.exitCode === 0 && listRes.stdout) {
          for (const id of parsePiListModelsOutput(listRes.stdout)) {
            addLive(id);
          }
        }
      } else if (driver === 'agy') {
        const [rawSettings, agyModelsRes] = await Promise.all([
          this.readTextFile(path.join(this.homeDir, '.gemini', 'antigravity', 'settings.json')),
          this.safeRun(resolvedCommand, ['models'], 9_000),
        ]);
        if (rawSettings) {
          const parsed = JSON.parse(rawSettings) as Record<string, unknown>;
          if (typeof parsed.model === 'string' && parsed.model.trim()) {
            defaultModel = parsed.model.trim();
            addConfig(defaultModel);
          }
        }
        const combinedAgyOut = `${agyModelsRes.stdout}\n${agyModelsRes.stderr}`;
        if (!agyModelsRes.notFound && !agyModelsRes.timedOut && combinedAgyOut.trim()) {
          for (const id of parseAgyModelsOutput(combinedAgyOut)) {
            addLive(id);
          }
        }
      } else if (driver === 'dsh') {
        const rawConfig = await this.readTextFile(
          path.join(this.homeDir, '.dsh', 'config.json'),
        );
        if (rawConfig) {
          const parsed = JSON.parse(rawConfig) as Record<string, unknown>;
          if (typeof parsed.model === 'string' && parsed.model.trim()) {
            defaultModel = parsed.model.trim();
            addConfig(defaultModel);
          }
        }
      }
    } catch {
      // Never fail probing due to malformed user config files or CLI output.
    }

    // When a CLI dynamically reports its own live model catalog (`agy models`, `opencode models`,
    // `~/.codex/models_cache.json`, `pi --list-models`), use ONLY user config + live catalog so
    // stale fallback IDs never pollute the list. Fall back to DRIVER_CURATED_MODELS only when
    // live discovery yielded nothing (e.g. offline, unauthenticated, or CLI lacks a list command).
    const fallbackModels = liveModels.length > 0 ? [] : DRIVER_CURATED_MODELS[driver];
    const seen = new Set<string>();
    const availableModels: string[] = [];
    for (const item of [
      ...(defaultModel ? [defaultModel] : []),
      ...configModels,
      ...liveModels,
      ...fallbackModels,
    ]) {
      const clean = item.trim();
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      availableModels.push(clean);
    }

    return { defaultModel, availableModels };
  }

  private async detectRefinedCapabilities(
    desc: BuiltInCliDescriptor,
    resolvedCommand = desc.command,
  ): Promise<AdapterCapabilities> {
    if (desc.id !== 'codex') {
      return { ...desc.capabilities };
    }

    // Verify whether this Codex installation supports `codex app-server`.
    const helpRes = await this.safeRun(resolvedCommand, ['app-server', '--help'], Math.min(2_000, this.timeoutMs));
    const combined = `${helpRes.stdout}\n${helpRes.stderr}`.toLowerCase();
    const lacksAppServer =
      helpRes.notFound === true ||
      (helpRes.exitCode !== 0 &&
        (combined.includes('unrecognized subcommand') ||
          combined.includes('unknown command') ||
          combined.includes('invalid subcommand')));

    if (lacksAppServer) {
      return {
        ...desc.capabilities,
        midTurnSteer: false,
        approvalCallback: false,
      };
    }
    return { ...desc.capabilities };
  }

  private async detectAuthHint(
    driver: Exclude<ExternalAgentDriverKind, 'custom'>,
    command: string,
  ): Promise<{ status: CliAuthStatus; hint?: string }> {
    if (driver === 'claude') {
      const envKey = hasNonEmptyEnv(this.env, [
        'ANTHROPIC_API_KEY',
        'CLAUDE_CODE_OAUTH_TOKEN',
        'ANTHROPIC_AUTH_TOKEN',
      ]);
      if (envKey) {
        return { status: 'authenticated', hint: `Configured via ${envKey}` };
      }
      if (
        (await this.fileExists(path.join(this.homeDir, '.claude', '.credentials.json'))) ||
        (await this.fileExists(path.join(this.homeDir, '.claude.json')))
      ) {
        return { status: 'authenticated', hint: 'Claude Code local credentials detected' };
      }
      const statusRes = await this.safeRun(command, ['auth', 'status'], 1_800);
      const out = `${statusRes.stdout}\n${statusRes.stderr}`.toLowerCase();
      if (statusRes.exitCode === 0 && (out.includes('"loggedin":true') || out.includes('"loggedin": true') || (out.includes('logged in') && !out.includes('not logged in')))) {
        return { status: 'authenticated', hint: 'Logged in via claude auth' };
      }
      if (out.includes('"loggedin":false') || out.includes('not logged in')) {
        return { status: 'unauthenticated', hint: 'Run `claude auth login` or set ANTHROPIC_API_KEY' };
      }
      return { status: 'unknown', hint: 'Verify login with `claude auth status`' };
    }

    if (driver === 'codex') {
      const envKey = hasNonEmptyEnv(this.env, ['OPENAI_API_KEY', 'CODEX_API_KEY']);
      if (envKey) {
        return { status: 'authenticated', hint: `Configured via ${envKey}` };
      }
      if (await this.fileExists(path.join(this.homeDir, '.codex', 'auth.json'))) {
        return { status: 'authenticated', hint: 'Codex auth.json detected' };
      }
      const statusRes = await this.safeRun(command, ['login', 'status'], 1_800);
      const out = `${statusRes.stdout}\n${statusRes.stderr}`.toLowerCase();
      if (statusRes.exitCode === 0 && (out.includes('logged in') && !out.includes('not logged in'))) {
        return { status: 'authenticated', hint: 'Logged in via codex login' };
      }
      if (out.includes('not logged in')) {
        return { status: 'unauthenticated', hint: 'Run `codex login` or set OPENAI_API_KEY' };
      }
      return { status: 'unknown', hint: 'Run `codex login` if prompted' };
    }

    if (driver === 'opencode') {
      const envKey = hasNonEmptyEnv(this.env, [
        'ANTHROPIC_API_KEY',
        'OPENAI_API_KEY',
        'DEEPSEEK_API_KEY',
        'GEMINI_API_KEY',
        'OPENROUTER_API_KEY',
      ]);
      if (envKey) {
        return { status: 'authenticated', hint: `Configured via ${envKey}` };
      }
      const xdgData = this.env.XDG_DATA_HOME || path.join(this.homeDir, '.local', 'share');
      if (await this.fileExists(path.join(xdgData, 'opencode', 'auth.json'))) {
        return { status: 'authenticated', hint: 'OpenCode auth store detected' };
      }
      return { status: 'unknown', hint: 'Configure provider via `opencode auth login`' };
    }

    if (driver === 'pi') {
      const envKey = hasNonEmptyEnv(this.env, [
        'ANTHROPIC_API_KEY',
        'OPENAI_API_KEY',
        'DEEPSEEK_API_KEY',
        'GEMINI_API_KEY',
      ]);
      if (envKey) {
        return { status: 'authenticated', hint: `Configured via ${envKey}` };
      }
      if (await this.fileExists(path.join(this.homeDir, '.pi', 'agent', 'auth.json'))) {
        return { status: 'authenticated', hint: 'Pi Agent auth.json detected' };
      }
      return { status: 'unknown', hint: 'Set provider API key or sign in with `pi`' };
    }

    if (driver === 'agy') {
      const envKey = hasNonEmptyEnv(this.env, ['GEMINI_API_KEY', 'GOOGLE_API_KEY']);
      if (envKey) {
        return { status: 'authenticated', hint: `Configured via ${envKey}` };
      }
      if (await this.fileExists(path.join(this.homeDir, '.gemini', 'antigravity', 'settings.json'))) {
        return { status: 'authenticated', hint: 'Antigravity profile detected' };
      }
      return { status: 'unknown', hint: 'Ensure Antigravity CLI is signed in' };
    }

    // dsh
    const dshEnv = hasNonEmptyEnv(this.env, ['DEEPSEEK_API_KEY', 'DSH_API_KEY', 'OPENAI_API_KEY']);
    if (dshEnv) {
      return { status: 'authenticated', hint: `Configured via ${dshEnv}` };
    }
    if (
      (await this.fileExists(path.join(this.homeDir, '.dsh', 'config.json'))) ||
      (await this.fileExists(path.join(this.homeDir, '.config', 'dsh', 'auth.json')))
    ) {
      return { status: 'authenticated', hint: 'DeepSeek Harness config detected' };
    }
    return { status: 'unknown', hint: 'Set DEEPSEEK_API_KEY or configure dsh' };
  }

  private async probeCustomTemplate(template: CustomCliTemplate): Promise<DetectedCliAgent> {
    const probedAt = this.now();
    const res = await this.safeRun(template.command, ['--version']);
    const combinedOutput = `${res.stdout}\n${res.stderr}`.trim();
    const version = extractSemanticVersion(combinedOutput);
    const installed = !res.notFound && !res.timedOut && (res.exitCode === 0 || version !== null || res.resolvedPath !== null);

    const capabilities: AdapterCapabilities = {
      ...DRIVER_DEFAULT_CAPABILITIES.custom,
      sessionResume: Boolean(template.resumeArgsTemplate && template.resumeArgsTemplate.length > 0),
      ...template.capabilitiesOverride,
    };

    const templateAuthKey = template.env
      ? Object.keys(template.env).find((k) => /(API_KEY|TOKEN|SECRET)/iu.test(k) && Boolean(template.env?.[k]))
      : undefined;

    return {
      id: `custom:${template.id}`,
      driver: 'custom',
      displayName: template.name,
      command: template.command,
      resolvedPath: installed ? (res.resolvedPath ?? template.command) : null,
      installed,
      version: installed ? version : null,
      authStatus: templateAuthKey ? 'authenticated' : 'unknown',
      authHint: templateAuthKey ? `Template env sets ${templateAuthKey}` : undefined,
      capabilities,
      probedAt,
      templateId: template.id,
    };
  }
}

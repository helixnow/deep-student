import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CustomCliTemplate } from '../src/adapter-types.ts';
import {
  CliAgentProber,
  createDefaultProbeCommandRunner,
  extractSemanticVersion,
  resolveExecutableOnPath,
  type ProbeCommandResult,
  type ProbeCommandRunner,
} from '../src/probe.ts';

describe('extractSemanticVersion', () => {
  it('extracts semantic versions across diverse CLI version outputs', () => {
    expect(extractSemanticVersion('2.1.76 (Claude Code)')).toBe('2.1.76');
    expect(extractSemanticVersion('codex-cli 0.114.0-beta.2\n')).toBe('0.114.0-beta.2');
    expect(extractSemanticVersion('opencode v1.3.9+build.42')).toBe('1.3.9+build.42');
    expect(extractSemanticVersion('pi 0.58.1')).toBe('0.58.1');
    expect(extractSemanticVersion('')).toBeNull();
  });
});

describe('CliAgentProber', () => {
  it('detects installed and missing CLIs, auth hints, custom templates, and never throws', async () => {
    const existingFiles = new Set<string>([
      '/home/alice/.codex/auth.json',
      '/home/alice/.gemini/antigravity/settings.json',
    ]);

    const runner: ProbeCommandRunner = async (command, args): Promise<ProbeCommandResult> => {
      if (command === 'claude' && args[0] === '--version') {
        return {
          exitCode: 0,
          stdout: '2.1.80 (Claude Code)\n',
          stderr: '',
          resolvedPath: '/usr/local/bin/claude',
        };
      }
      if (command === 'codex' && args[0] === '--version') {
        return {
          exitCode: 0,
          stdout: 'codex-cli 0.116.0\n',
          stderr: '',
          resolvedPath: '/usr/local/bin/codex',
        };
      }
      if (command === 'codex' && args[0] === 'app-server') {
        return {
          exitCode: 0,
          stdout: 'Usage: codex app-server\n',
          stderr: '',
          resolvedPath: '/usr/local/bin/codex',
        };
      }
      if (command === 'opencode') {
        throw new Error('spawn opencode ENOENT');
      }
      if (command === 'pi') {
        return {
          exitCode: null,
          stdout: '',
          stderr: '',
          notFound: true,
          resolvedPath: null,
        };
      }
      if (command === 'agy' && args[0] === '--version') {
        return {
          exitCode: 0,
          stdout: 'agy 2.0.4\n',
          stderr: '',
          resolvedPath: '/opt/agy/bin/agy',
        };
      }
      if (command === 'dsh' && args[0] === '--version') {
        return {
          exitCode: null,
          stdout: '',
          stderr: 'timed out',
          timedOut: true,
          resolvedPath: '/usr/local/bin/dsh',
        };
      }
      if (command === 'my-coder' && args[0] === '--version') {
        return {
          exitCode: 0,
          stdout: 'my-coder v0.9.2',
          stderr: '',
          resolvedPath: '/usr/local/bin/my-coder',
        };
      }
      return { exitCode: 1, stdout: '', stderr: 'unknown', notFound: true };
    };

    const customTemplate: CustomCliTemplate = {
      id: 'my-coder',
      name: 'My Coder CLI',
      command: 'my-coder',
      argsTemplate: ['exec', '{{prompt}}'],
      resumeArgsTemplate: ['exec', '--resume', '{{sessionId}}', '{{prompt}}'],
      env: { MY_CODER_API_KEY: 'sk-custom-123' },
    };

    const prober = new CliAgentProber({
      commandRunner: runner,
      fileExists: async (p) => existingFiles.has(p),
      env: {
        ANTHROPIC_API_KEY: 'sk-ant-test',
        PATH: '/usr/local/bin:/usr/bin',
      },
      homeDir: '/home/alice',
      now: () => 1_700_000_000_000,
    });

    const detected = await prober.probeAll({ customTemplates: [customTemplate] });
    expect(detected).toHaveLength(7);

    const byId = new Map(detected.map((a) => [a.id, a]));

    const claude = byId.get('claude')!;
    expect(claude.installed).toBe(true);
    expect(claude.version).toBe('2.1.80');
    expect(claude.resolvedPath).toBe('/usr/local/bin/claude');
    expect(claude.authStatus).toBe('authenticated');
    expect(claude.authHint).toContain('ANTHROPIC_API_KEY');
    expect(claude.capabilities.nativeSubagentTree).toBe(true);
    expect(claude.capabilities.midTurnSteer).toBe(true);

    const codex = byId.get('codex')!;
    expect(codex.installed).toBe(true);
    expect(codex.version).toBe('0.116.0');
    expect(codex.authStatus).toBe('authenticated');
    expect(codex.capabilities.midTurnSteer).toBe(true);
    expect(codex.capabilities.approvalCallback).toBe(true);

    const opencode = byId.get('opencode')!;
    expect(opencode.installed).toBe(false);
    expect(opencode.version).toBeNull();
    expect(opencode.resolvedPath).toBeNull();

    const pi = byId.get('pi')!;
    expect(pi.installed).toBe(false);

    const agy = byId.get('agy')!;
    expect(agy.installed).toBe(true);
    expect(agy.version).toBe('2.0.4');
    expect(agy.authStatus).toBe('authenticated');
    expect(agy.capabilities.midTurnSteer).toBe(false);

    // Timed-out CLI is treated safely as not ready rather than throwing
    const dsh = byId.get('dsh')!;
    expect(dsh.installed).toBe(false);

    const custom = byId.get('custom:my-coder')!;
    expect(custom.installed).toBe(true);
    expect(custom.version).toBe('0.9.2');
    expect(custom.authStatus).toBe('authenticated');
    expect(custom.capabilities.sessionResume).toBe(true);
    expect(custom.capabilities.midTurnSteer).toBe(false);
  });

  it('downgrades Codex midTurnSteer & approvalCallback when codex app-server is unsupported', async () => {
    const prober = new CliAgentProber({
      commandRunner: async (cmd, args) => {
        if (cmd === 'codex' && args[0] === '--version') {
          return { exitCode: 0, stdout: 'codex 0.1.0', stderr: '', resolvedPath: '/bin/codex' };
        }
        if (cmd === 'codex' && args[0] === 'app-server') {
          return {
            exitCode: 2,
            stdout: '',
            stderr: "error: unrecognized subcommand 'app-server'",
            resolvedPath: '/bin/codex',
          };
        }
        return { exitCode: null, stdout: '', stderr: '', notFound: true };
      },
      fileExists: async () => false,
      env: {},
      homeDir: '/tmp/nonexistent-home',
    });

    const agents = await prober.probeAll();
    const codex = agents.find((a) => a.id === 'codex')!;
    expect(codex.installed).toBe(true);
    expect(codex.capabilities.midTurnSteer).toBe(false);
    expect(codex.capabilities.approvalCallback).toBe(false);
  });

  it('caches probe results for ttlMs (default 30s) and refreshes on expiry or forceRefresh', async () => {
    let clock = 1_000_000;
    let calls = 0;

    const prober = new CliAgentProber({
      ttlMs: 30_000,
      now: () => clock,
      fileExists: async () => false,
      env: { ANTHROPIC_API_KEY: 'sk-1' },
      commandRunner: async (cmd, args) => {
        if (args[0] === '--version') {
          calls += 1;
          if (cmd === 'claude') {
            return { exitCode: 0, stdout: `2.0.${calls}`, stderr: '', resolvedPath: '/bin/claude' };
          }
        }
        return { exitCode: null, stdout: '', stderr: '', notFound: true };
      },
    });

    const first = await prober.probeAll();
    expect(first.find((a) => a.id === 'claude')?.version).toBe('2.0.1');
    const callsAfterFirst = calls;
    expect(callsAfterFirst).toBe(6);

    // Within 30s TTL -> zero additional command invocations
    clock += 15_000;
    const cached = await prober.probeAll();
    expect(calls).toBe(callsAfterFirst);
    expect(cached.find((a) => a.id === 'claude')?.version).toBe('2.0.1');

    // Past 30s TTL -> re-probes
    clock += 16_000;
    const refreshed = await prober.probeAll();
    expect(calls).toBe(callsAfterFirst * 2);
    expect(refreshed.find((a) => a.id === 'claude')?.version).toBe('2.0.7');

    // Explicit forceRefresh before TTL expires -> re-probes immediately
    const forced = await prober.probeAll({ forceRefresh: true });
    expect(calls).toBe(callsAfterFirst * 3);
    expect(forced.find((a) => a.id === 'claude')?.version).toBe('2.0.13');
  });

  it('resolves real executable scripts on PATH and returns notFound for missing binaries', async () => {
    if (process.platform === 'win32') return;

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dstu-probe-test-'));
    try {
      const cliPath = path.join(tempDir, 'sample-agent-cli');
      await fs.writeFile(
        cliPath,
        '#!/bin/sh\necho "sample-agent-cli 3.4.5"\n',
        { mode: 0o755 },
      );

      const env = { PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ''}` };
      const resolved = await resolveExecutableOnPath('sample-agent-cli', env);
      expect(resolved).toBe(cliPath);

      const missing = await resolveExecutableOnPath('definitely-not-installed-cli-xyz', env);
      expect(missing).toBeNull();

      const runner = createDefaultProbeCommandRunner();
      const okResult = await runner('sample-agent-cli', ['--version'], {
        timeoutMs: 3_000,
        env,
      });
      expect(okResult.notFound).toBeUndefined();
      expect(okResult.exitCode).toBe(0);
      expect(extractSemanticVersion(okResult.stdout)).toBe('3.4.5');

      const missingResult = await runner('definitely-not-installed-cli-xyz', ['--version'], {
        timeoutMs: 1_000,
        env,
      });
      expect(missingResult.notFound).toBe(true);
      expect(missingResult.resolvedPath).toBeNull();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('augments macOS Finder GUI PATH with ~/.grok/bin & ~/.local/bin while keeping explicit PATH overrides first, and exposes getCachedAgent', async () => {
    if (process.platform === 'win32') return;

    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dstu-probe-home-'));
    const overrideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dstu-probe-override-'));
    try {
      const grokBin = path.join(fakeHome, '.grok', 'bin');
      const localBin = path.join(fakeHome, '.local', 'bin');
      await fs.mkdir(grokBin, { recursive: true });
      await fs.mkdir(localBin, { recursive: true });

      const codexInGrok = path.join(grokBin, 'codex');
      await fs.writeFile(
        codexInGrok,
        '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.120.0"; exit 0; fi\nif [ "$1" = "app-server" ]; then echo "Usage: codex app-server"; exit 0; fi\nexit 0\n',
        { mode: 0o755 },
      );

      const claudeInLocal = path.join(localBin, 'claude');
      await fs.writeFile(
        claudeInLocal,
        '#!/bin/sh\necho "2.2.0 (Claude Code)"\n',
        { mode: 0o755 },
      );

      const claudeOverride = path.join(overrideDir, 'claude');
      await fs.writeFile(
        claudeOverride,
        '#!/bin/sh\necho "9.9.9 (Override Claude)"\n',
        { mode: 0o755 },
      );

      // Minimal Finder-like PATH (/usr/bin:/bin) + explicit overrideDir first
      const prober = new CliAgentProber({
        env: {
          HOME: fakeHome,
          PATH: `${overrideDir}:/usr/bin:/bin`,
          OPENAI_API_KEY: 'sk-openai-test',
          ANTHROPIC_API_KEY: 'sk-ant-test',
        },
        homeDir: fakeHome,
        platform: 'darwin',
      });

      expect(prober.getCachedAgent('codex')).toBeUndefined();

      const detected = await prober.probeAll();
      const codex = prober.getCachedAgent('codex');
      expect(codex).toBeDefined();
      expect(codex?.installed).toBe(true);
      expect(codex?.resolvedPath).toBe(codexInGrok);
      expect(codex?.version).toBe('0.120.0');

      // Explicit PATH entry (`overrideDir`) must take priority over `~/.local/bin`!
      const claude = prober.getCachedAgent('claude');
      expect(claude?.installed).toBe(true);
      expect(claude?.resolvedPath).toBe(claudeOverride);
      expect(claude?.version).toBe('9.9.9');
      expect(detected.find((a) => a.id === 'claude')?.resolvedPath).toBe(claudeOverride);
    } finally {
      await fs.rm(fakeHome, { recursive: true, force: true });
      await fs.rm(overrideDir, { recursive: true, force: true });
    }
  });

  it('parses live CLI model catalogs (agy models, opencode models, codex models_cache.json, claude settings.json) without stale fallback pollution', async () => {
    const mockFiles: Record<string, string> = {
      '/home/dev/.claude/settings.json': JSON.stringify({
        model: 'fable',
        modelSettings: {
          'claude-fable-5-2': { effortLevel: 'high' },
        },
        env: {
          ANTHROPIC_SMALL_FAST_MODEL: 'claude-haiku-5-5',
        },
      }),
      '/home/dev/.codex/config.toml': 'model = "gpt-6.2-sol"\nmodel_reasoning_effort = "xhigh"\n',
      '/home/dev/.codex/models_cache.json': JSON.stringify({
        models: [
          { slug: 'gpt-6.1-terra', visibility: 'list', priority: 2 },
          { slug: 'gpt-reserve', visibility: 'hide', priority: 0 },
          { slug: 'gpt-6.2-sol', visibility: 'list', priority: 1 },
          { slug: 'codex-auto-review', visibility: 'hide', priority: 3 },
        ],
      }),
      '/home/dev/.config/opencode/opencode.json': JSON.stringify({
        model: 'opencode-go/gpt-6-luna',
      }),
    };

    const prober = new CliAgentProber({
      homeDir: '/home/dev',
      env: {},
      fileExists: async (p) => p in mockFiles,
      readTextFile: async (p) => mockFiles[p] ?? null,
      commandRunner: async (cmd, args) => {
        if (
          args[0] === '--version' &&
          (cmd === 'claude' || cmd === 'codex' || cmd === 'opencode' || cmd === 'agy')
        ) {
          return { exitCode: 0, stdout: `${cmd} 2.2.0`, stderr: '', resolvedPath: `/bin/${cmd}` };
        }
        if (cmd.endsWith('codex') && args[0] === 'app-server') {
          return { exitCode: 0, stdout: 'Usage: codex app-server', stderr: '' };
        }
        if (cmd.endsWith('agy') && args[0] === 'models') {
          return {
            exitCode: 0,
            stdout:
              '\r⠋ Fetching available models...\rgemini-4-neon-high\tGemini 4 Neon (High)\nclaude-opus-5-5-high           Claude Opus 5.5 (High)\n',
            stderr: '',
          };
        }
        if (cmd.endsWith('opencode') && args[0] === 'models') {
          return {
            exitCode: 0,
            stdout: 'composite/gemini-4-argon\nopencode-go/gpt-6-luna\ndeepseek/deepseek-v4-pro\n',
            stderr: '',
          };
        }
        return { exitCode: null, stdout: '', stderr: '', notFound: true };
      },
    });

    const detected = await prober.probeAll();
    const byId = new Map(detected.map((a) => [a.id, a]));

    const claude = byId.get('claude')!;
    expect(claude.defaultModel).toBe('fable');
    expect(claude.availableModels).toContain('claude-fable-5-2');
    expect(claude.availableModels).toContain('claude-opus-5-5');
    expect(claude.availableModels).toContain('claude-haiku-5-5');

    // Codex reads models_cache.json sorted by priority and omits visibility: 'hide'
    const codex = byId.get('codex')!;
    expect(codex.defaultModel).toBe('gpt-6.2-sol');
    expect(codex.availableModels).toEqual(['gpt-6.2-sol', 'gpt-6.1-terra']);

    // Antigravity CLI parses `agy models` live output cleanly without spinner noise or old 2.5 fallbacks
    const agy = byId.get('agy')!;
    expect(agy.availableModels).toEqual(['gemini-4-neon-high', 'claude-opus-5-5-high']);

    // OpenCode parses `opencode models` live output cleanly
    const opencode = byId.get('opencode')!;
    expect(opencode.defaultModel).toBe('opencode-go/gpt-6-luna');
    expect(opencode.availableModels).toEqual([
      'opencode-go/gpt-6-luna',
      'composite/gemini-4-argon',
      'deepseek/deepseek-v4-pro',
    ]);
  });

  it('rejects crashed Node.js shims (ignoring Node.js vX.Y.Z in stderr) and falls back to macOS ChatGPT.app bundled Codex CLI', async () => {
    const bundledCodex =
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';

    const prober = new CliAgentProber({
      platform: 'darwin',
      homeDir: '/Users/dev',
      env: {},
      fileExists: async (p) => p === bundledCodex,
      readTextFile: async () => null,
      commandRunner: async (cmd, args) => {
        if (cmd === 'codex' && args[0] === '--version') {
          return {
            exitCode: 1,
            stdout: '',
            stderr:
              'Error: Missing optional dependency @openai/codex-darwin-arm64.\nNode.js v26.5.0\n',
            resolvedPath: '/Users/dev/.local/bin/codex',
          };
        }
        if (cmd === bundledCodex && args[0] === '--version') {
          return {
            exitCode: 0,
            stdout: 'codex-cli 0.171.0-alpha.13.2\n',
            stderr: '',
            resolvedPath: bundledCodex,
          };
        }
        if (cmd === bundledCodex && args[0] === 'app-server') {
          return { exitCode: 0, stdout: 'Usage: codex app-server\n', stderr: '' };
        }
        if (cmd === bundledCodex && args[0] === 'login') {
          return { exitCode: 0, stdout: 'Logged in using ChatGPT\n', stderr: '' };
        }
        return { exitCode: null, stdout: '', stderr: '', notFound: true };
      },
    });

    const detected = await prober.probeAll();
    const codex = detected.find((a) => a.id === 'codex')!;
    expect(codex.installed).toBe(true);
    expect(codex.resolvedPath).toBe(bundledCodex);
    expect(codex.version).toBe('0.171.0-alpha.13.2');
    expect(codex.authStatus).toBe('authenticated');
    expect(codex.capabilities.midTurnSteer).toBe(true);
  });

  it('skips broken PATH shim to next healthy PATH executable and rejects crashed custom templates', async () => {
    const prober = new CliAgentProber({
      platform: 'darwin',
      homeDir: '/Users/dev',
      env: {},
      fileExists: async () => false,
      readTextFile: async () => null,
      resolveAllExecutables: async (cmd) => {
        if (cmd === 'opencode') {
          return ['/Users/dev/.local/bin/opencode', '/opt/homebrew/bin/opencode'];
        }
        return [];
      },
      commandRunner: async (cmd, args) => {
        if (cmd === 'opencode' && args[0] === '--version') {
          return {
            exitCode: 1,
            stdout: '',
            stderr: 'Error: broken npm shim\nNode.js v26.5.0\n',
            resolvedPath: '/Users/dev/.local/bin/opencode',
          };
        }
        if (cmd === '/opt/homebrew/bin/opencode' && args[0] === '--version') {
          return {
            exitCode: 0,
            stdout: '1.14.19\n',
            stderr: '',
            resolvedPath: '/opt/homebrew/bin/opencode',
          };
        }
        if (cmd === '/usr/local/bin/broken-custom' && args[0] === '--version') {
          return {
            exitCode: 1,
            stdout: '',
            stderr: 'Error: missing shared lib\nNode.js v26.5.0\n',
            resolvedPath: '/usr/local/bin/broken-custom',
          };
        }
        return { exitCode: null, stdout: '', stderr: '', notFound: true };
      },
    });

    const detected = await prober.probeAll({
      customTemplates: [
        {
          id: 'broken',
          name: 'Broken Custom',
          command: '/usr/local/bin/broken-custom',
          argsTemplate: ['{{prompt}}'],
        },
      ],
    });

    const opencode = detected.find((a) => a.id === 'opencode')!;
    expect(opencode.installed).toBe(true);
    expect(opencode.resolvedPath).toBe('/opt/homebrew/bin/opencode');
    expect(opencode.version).toBe('1.14.19');

    const custom = detected.find((a) => a.id === 'custom:broken')!;
    expect(custom.installed).toBe(false);
    expect(custom.resolvedPath).toBeNull();
    expect(custom.probeError).toContain('missing shared lib');
  });

  it('honors per-CLI custom executablePath overrides and surfaces probeError if custom path is invalid', async () => {
    const prober = new CliAgentProber({
      platform: 'darwin',
      homeDir: '/Users/dev',
      env: {},
      fileExists: async () => false,
      readTextFile: async () => null,
      resolveAllExecutables: async () => ['/usr/local/bin/claude'],
      commandRunner: async (cmd, args) => {
        if (cmd === '/custom/bin/claude' && args[0] === '--version') {
          return {
            exitCode: 0,
            stdout: '2.5.0 (Claude Code)',
            stderr: '',
            resolvedPath: '/custom/bin/claude',
          };
        }
        if (cmd === '/bad/path/codex' && args[0] === '--version') {
          return {
            exitCode: null,
            stdout: '',
            stderr: 'ENOENT',
            notFound: true,
            resolvedPath: null,
          };
        }
        return { exitCode: null, stdout: '', stderr: '', notFound: true };
      },
    });

    const detected = await prober.probeAll({
      cliOverrides: [
        {
          agentId: 'claude',
          executablePath: '/custom/bin/claude',
          extraArgs: ['--verbose'],
        },
        {
          agentId: 'codex',
          executablePath: '/bad/path/codex',
        },
      ],
    });

    const claude = detected.find((a) => a.id === 'claude')!;
    expect(claude.installed).toBe(true);
    expect(claude.resolvedPath).toBe('/custom/bin/claude');
    expect(claude.customExecutablePath).toBe('/custom/bin/claude');
    expect(claude.extraArgs).toEqual(['--verbose']);
    expect(claude.version).toBe('2.5.0');

    const codex = detected.find((a) => a.id === 'codex')!;
    expect(codex.installed).toBe(false);
    expect(codex.customExecutablePath).toBe('/bad/path/codex');
    expect(codex.probeError).toBeTruthy();
  });
});

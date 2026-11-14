import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import { loadMcpConfig } from '../src/config.ts';
import {
  LineReader, STDIO_UNSUPPORTED_ON_MOBILE_MSG, StdioSessionManager, createStdioTransport,
  formatContentLengthFrame, framingFromStr, minimalChildEnvKeys, readContentLengthMessage,
  runContentLengthReadLoop, type StdioLog,
} from '../src/stdio-proxy.ts';
import { normalizeCommandPath } from '../src/stdio-validation.ts';
import { currentStdioRuntime } from '../equivalence/runtime.ts';

const runtime = currentStdioRuntime();

function readerFor(text: string): LineReader {
  let buffer = Buffer.from(text, 'utf8');
  return new LineReader(async (size: number) => {
    if (!buffer.length) return null;
    const out = buffer.subarray(0, size);
    buffer = buffer.subarray(size);
    return out;
  });
}

function settingsWithTools(value: unknown): SettingsStore {
  const values = new Map<string, string>([['mcp.tools.list', JSON.stringify(value)]]);
  return { get: (key: string) => values.get(key) ?? null } as unknown as SettingsStore;
}

async function withChildScript(
  source: string,
  run: (script: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-stdio-child-'));
  const script = join(dir, 'child.cjs');
  await writeFile(script, source);
  try { await run(script); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

function captureLog(): { lines: string[]; log: StdioLog } {
  const lines: string[] = [];
  return {
    lines,
    log: (level, message) => { lines.push(`${level}: ${message}`); },
  };
}

async function waitForChildReady(
  transport: Awaited<ReturnType<typeof createStdioTransport>>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      transport.child.stdout.off('data', onData);
      reject(new Error('child did not report ready'));
    }, 2_000);
    const onData = (chunk: Buffer): void => {
      if (!chunk.toString('utf8').includes('ready')) return;
      clearTimeout(timer);
      transport.child.stdout.off('data', onData);
      resolve();
    };
    transport.child.stdout.on('data', onData);
  });
}

async function closeAndAssertTerminated(
  transport: Awaited<ReturnType<typeof createStdioTransport>>,
): Promise<void> {
  try { await transport.close(); }
  finally {
    if (transport.child.exitCode === null && transport.child.signalCode === null) {
      transport.child.kill('SIGKILL');
    }
  }
}

describe('mcp/global.rs tests', () => {
  it('consumes a final unterminated line once and then reports EOF', async () => {
    const reader = readerFor('{"id":1}');
    expect(await reader.readLine()).toBe('{"id":1}');
    expect(await reader.readLine()).toBeNull();
    expect(await reader.readLine()).toBeNull();
  });

  it('mcp_stdio production session emits the final partial line once and auto-cleans after child EOF', async () => {
    await withChildScript(String.raw`process.stdout.write('{"id":1}\n{"id":2}');`, async script => {
      const messages: string[] = [];
      const closedEvents: string[] = [];
      let resolveClosed!: () => void;
      const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
      const { log, lines } = captureLog();
      const manager = new StdioSessionManager((event, payload) => {
        if (event.endsWith('-message')) {
          if (payload === null || typeof payload !== 'object' || !('message' in payload) || typeof payload.message !== 'string') {
            throw new Error('invalid message payload');
          }
          messages.push(payload.message);
          // Keep a regression finite: the fixture has exactly two messages, so an unexpected third
          // is retained for the outer assertion and terminates the faulty read loop via its catch.
          if (messages.length > 2) throw new Error('unexpected third message after final partial line');
        }
        if (event.endsWith('-closed')) { closedEvents.push(event); resolveClosed(); }
      }, log);
      try {
        const id = await manager.start(runtime.command, [script], runtime.env, 'jsonl', null);
        await closed;
        expect(messages).toEqual(['{"id":1}', '{"id":2}']);
        expect(closedEvents).toEqual([`mcp-stdio-${id}-closed`]);
        expect(manager._sessions.size).toBe(0);
        expect(lines.some(line => line.startsWith('error: Error reading from MCP stdout'))).toBe(false);
      } finally { await manager.dispose(); }
    });
  });

  it('normalize_command_path_strips_extended_length_prefixes', () => {
    expect(normalizeCommandPath('\\\\?\\C:\\Users\\a\\.playwright-mcp\\start-mcp.cmd')).toBe('C:\\Users\\a\\.playwright-mcp\\start-mcp.cmd');
    expect(normalizeCommandPath('\\\\?\\UNC\\server\\share\\mcp.cmd')).toBe('\\\\server\\share\\mcp.cmd');
    expect(normalizeCommandPath('C:\\Program Files\\nodejs\\node.exe')).toBe('C:\\Program Files\\nodejs\\node.exe');
    expect(normalizeCommandPath('/usr/local/bin/node')).toBe('/usr/local/bin/node');
    expect(normalizeCommandPath('npx')).toBe('npx');
  });
  it('test_format_content_length_frame_basic', () => {
    const message = '{"jsonrpc":"2.0","id":1,"method":"test"}';
    expect(formatContentLengthFrame(message)).toBe(`Content-Length: ${message.length}\r\n\r\n${message}`);
  });
  it('test_format_content_length_frame_empty', () => {
    expect(formatContentLengthFrame('')).toBe('Content-Length: 0\r\n\r\n');
  });
  it('test_format_content_length_frame_unicode', () => {
    const message = '{"method":"测试","params":{"中文":"内容"}}';
    const byteLength = Buffer.byteLength(message);
    expect(formatContentLengthFrame(message)).toBe(`Content-Length: ${byteLength}\r\n\r\n${message}`);
    expect(byteLength).toBeGreaterThan(30);
  });
  it('test_format_content_length_frame_with_newlines', () => {
    const message = '{\n  "method": "test",\n  "params": {}\n}';
    expect(formatContentLengthFrame(message)).toBe(`Content-Length: ${message.length}\r\n\r\n${message}`);
  });
  it('test_default_framing_is_jsonl', () => {
    expect(framingFromStr(undefined)).toBe('jsonl');
    expect(framingFromStr('')).toBe('jsonl');
    expect(framingFromStr('content-length')).toBe('content_length');
    expect(framingFromStr(' Content-Length ')).toBe('jsonl');
  });
  it('test_read_content_length_message_parses_frame', async () => {
    const payload = '{"jsonrpc":"2.0","id":1}';
    expect(await readContentLengthMessage(readerFor(formatContentLengthFrame(payload)))).toEqual({ kind: 'frame', message: payload });
  });
  it('test_read_content_length_message_falls_back_on_json_first_line', async () => {
    const read = await readContentLengthMessage(readerFor('{"jsonrpc":"2.0","id":1,"result":{}}\n'));
    expect(read.kind).toBe('jsonl');
    if (read.kind === 'jsonl') { expect(read.line.startsWith('{')).toBe(true); expect(read.line).toContain('"id":1'); }
  });
  it('test_run_content_length_loop_switches_to_jsonl_after_fallback', async () => {
    const messages: string[] = [];
    await runContentLengthReadLoop(readerFor('{"id":1}\n{"id":2}\n{"id":3}\n'), m => messages.push(m));
    expect(messages[0]).toBe('{"id":1}');
    expect(messages[1]).toBe('{"id":2}');
    expect(messages[2]).toBe('{"id":3}');
    expect(messages).toHaveLength(3);
  });
  it('test_spawn_failure_error_contains_diagnostics', async () => {
    const bogus = 'definitely-not-a-real-mcp-cmd-9f3b7a';
    let error: unknown;
    try { await createStdioTransport(bogus, [], 'jsonl', {}, null); }
    catch (e) { error = e; }
    const message = String(error);
    expect(message).toContain(`Failed to spawn process "${bogus}"`);
    expect(message).toContain('No such file or directory (os error 2)');
    expect(message).toContain('(kind=NotFound, os_error=2)');
  });
  it('mcp_stdio_start_waits_for_async_spawn_error_before_returning', async () => {
    const bogus = 'definitely-not-a-real-mcp-cmd-9f3b7a';
    const manager = new StdioSessionManager(() => undefined);
    let error: unknown;
    try { await manager.start(bogus, [], {}, 'jsonl', null); }
    catch (e) { error = e; }
    expect(String(error)).toContain(`Failed to spawn process "${bogus}"`);
    expect(String(error)).toContain('kind=NotFound');
    expect(manager._sessions.size).toBe(0);
  });
  it('close_closes_stdin_and_waits_for_graceful_exit', async () => {
    await withChildScript(
      String.raw`
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
console.log('ready');
`,
      async script => {
        const { lines, log } = captureLog();
        const transport = await createStdioTransport(
          runtime.command, [script], 'jsonl', runtime.env, null,
          { log, closeTiming: { gracefulMs: 2_000, sigtermMs: 2_000, sigkillMs: 2_000 } },
        );
        try {
          await waitForChildReady(transport);
          const started = Date.now();
          await transport.close();
          expect(Date.now() - started).toBeLessThan(2_000);
          expect(transport.child.exitCode).toBe(0);
          expect(transport.child.signalCode).toBeNull();
          expect(lines.some(line => line.includes('exited gracefully on close()'))).toBe(true);
        } finally {
          if (transport.child.exitCode === null && transport.child.signalCode === null) {
            transport.child.kill('SIGKILL');
          }
        }
      },
    );
  });
  it('close_sends_sigterm_after_graceful_timeout_and_reports_it', async () => {
    await withChildScript(
      String.raw`
process.on('SIGTERM', () => process.exit(0));
process.stdin.resume();
console.log('ready');
setInterval(() => {}, 1000);
`,
      async script => {
        const { lines, log } = captureLog();
        const transport = await createStdioTransport(
          runtime.command, [script], 'jsonl', runtime.env, null,
          { log, closeTiming: { gracefulMs: 100, sigtermMs: 2_000, sigkillMs: 2_000 } },
        );
        await waitForChildReady(transport);
        await closeAndAssertTerminated(transport);
        expect(transport.child.exitCode).toBe(0);
        expect(lines.some(line => line.includes('did not exit within 100ms, sending SIGTERM'))).toBe(true);
        expect(lines.some(line => line.includes('exited after SIGTERM'))).toBe(true);
      },
    );
  });
  it('close_escalates_to_sigkill_when_child_ignores_sigterm', async () => {
    await withChildScript(
      String.raw`
process.on('SIGTERM', () => {});
process.stdin.resume();
console.log('ready');
setInterval(() => {}, 1000);
`,
      async script => {
        const { lines, log } = captureLog();
        const transport = await createStdioTransport(
          runtime.command, [script], 'jsonl', runtime.env, null,
          { log, closeTiming: { gracefulMs: 100, sigtermMs: 100, sigkillMs: 3_000 } },
        );
        await waitForChildReady(transport);
        await closeAndAssertTerminated(transport);
        expect(transport.child.signalCode).toBe('SIGKILL');
        expect(lines.some(line => line.includes('did not exit after SIGTERM within 100ms, sending SIGKILL'))).toBe(true);
        expect(lines.some(line => line.includes('terminated (forced) on close()'))).toBe(true);
      },
    );
  });
  it('test_minimal_child_env_keys_includes_dev_toolchain_and_proxy', () => {
    for (const key of ['SYSTEMDRIVE', 'PROGRAMDATA', 'PUBLIC', 'PSMODULEPATH', 'NODE_PATH', 'NPM_CONFIG_PREFIX', 'NPM_CONFIG_CACHE', 'NVM_HOME', 'NVM_SYMLINK', 'VOLTA_HOME', 'FNM_DIR']) expect(minimalChildEnvKeys('win32')).toContain(key);
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy']) expect(minimalChildEnvKeys('win32')).toContain(key);
    for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY']) expect(minimalChildEnvKeys('win32')).not.toContain(key);
  });
  it('test_minimal_child_env_keys_posix_includes_dev_toolchain_and_proxy', () => {
    for (const key of ['NVM_DIR', 'VOLTA_HOME', 'FNM_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'SSH_AUTH_SOCK']) expect(minimalChildEnvKeys('darwin')).toContain(key);
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy']) expect(minimalChildEnvKeys('linux')).toContain(key);
    for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY']) expect(minimalChildEnvKeys('linux')).not.toContain(key);
  });
});

describe('mcp/stdio_proxy.rs tests', () => {
  it('mobile_stdio_rejection_message_is_stable', () => {
    expect(STDIO_UNSUPPORTED_ON_MOBILE_MSG).toContain('not supported');
    expect(STDIO_UNSUPPORTED_ON_MOBILE_MSG.toLowerCase()).toContain('stdio');
  });
  it('network_mcp_transport_variants_remain_available', () => {
    const sse = loadMcpConfig(settingsWithTools([{
      transportType: 'sse', endpoint: 'https://example.com/sse', apiKey: 'k',
      headers: { 'X-Test': '1' },
    }]));
    expect(sse.transport).toMatchObject({
      type: 'sse', endpoint: 'https://example.com/sse', api_key: 'k', headers: { 'X-Test': '1' },
    });

    const stream = loadMcpConfig(settingsWithTools([{
      transportType: 'streamable_http', url: 'https://example.com/mcp',
    }]));
    expect(stream.transport).toMatchObject({
      type: 'streamable_http', url: 'https://example.com/mcp',
    });

    const websocket = loadMcpConfig(settingsWithTools([{
      transportType: 'websocket', url: 'ws://example.com/ws', env: { A: 'B' },
    }]));
    expect(websocket.transport).toMatchObject({
      type: 'websocket', url: 'ws://example.com/ws', env: { A: 'B' },
    });

    const warnings: string[] = [];
    const unknown = loadMcpConfig(
      settingsWithTools([{ transportType: 'http', url: 'https://example.com/mcp' }]),
      message => warnings.push(message),
    );
    expect(unknown.transport.type).toBe('stdio');
    expect(warnings.some(message => message.includes('Unknown transport type'))).toBe(true);
  });
});

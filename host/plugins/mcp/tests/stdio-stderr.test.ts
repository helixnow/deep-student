import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { defaultMcpConfig } from '../src/config.ts';
import { connectMcpClient } from '../src/client.ts';
import { monitorStderr, StdioSessionManager, type StdioLog } from '../src/stdio-proxy.ts';
import { currentStdioRuntime } from '../equivalence/runtime.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import { createLogService } from '../../../platform/log/index.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import mcpPlugin from '../index.ts';

const runtime = currentStdioRuntime();

function logs() {
  const lines: string[] = [];
  const log: StdioLog = (level, message) => { lines.push(`${level}: ${message}`); };
  return { lines, log };
}

async function withScript(source: string, run: (path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'mcp-stderr-'));
  try {
    const script = join(root, 'child.cjs');
    await writeFile(script, source);
    await run(script);
  } finally { await rm(root, { recursive: true, force: true }); }
}

describe('X6-LP-0168/0169 global.rs:721-742 stderr monitor', () => {
  it('preserves byte-split UTF-8 and uses Rust trim_end, including the EOF tail', async () => {
    const text = '  中文告警\u0085\nsecond\ufeff\n\u0085\nlast';
    // Real Readable byte fixtures force every possible UTF-8 boundary; no decoder is replaced.
    const stderr = Readable.from([...Buffer.from(text)].map(byte => Buffer.from([byte])));
    const { lines, log } = logs();
    await monitorStderr(stderr, log);
    expect(lines).toEqual([
      'warn: MCP stderr:   中文告警',
      'warn: MCP stderr: second\ufeff',
      'warn: MCP stderr: last',
      'info: MCP stderr reader terminated',
    ]);
    expect(stderr.destroyed).toBe(true);
  });

  it('logs a Rust read_line InvalidData error and terminates instead of replacing invalid bytes', async () => {
    const stderr = Readable.from([Buffer.from('first\n'), Buffer.from([0xff, 0x0a]), Buffer.from('must not be logged\n')]);
    const { lines, log } = logs();
    await monitorStderr(stderr, log);
    expect(lines).toEqual([
      'warn: MCP stderr: first',
      'error: Error reading from MCP stderr: stream did not contain valid UTF-8',
      'info: MCP stderr reader terminated',
    ]);
    expect(stderr.destroyed).toBe(true);
  });

  it('the real backend client forwards child stderr to the host logger', async () => {
    await withScript(String.raw`
const readline = require('node:readline');
process.stderr.write('backend 中文告警\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const message = JSON.parse(line);
  if (message.id == null) return;
  const result = message.method === 'initialize'
    ? { protocolVersion: message.params.protocolVersion, capabilities: {}, serverInfo: { name: 'stderr', version: '1' } }
    : { tools: [] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
});
`, async script => {
      const { lines, log } = logs();
      const config = defaultMcpConfig();
      config.transport = { type: 'stdio', command: runtime.command, args: [script], framing: 'jsonl', env: runtime.env };
      config.performance.timeout_ms = 5000;
      const client = await connectMcpClient(config, log);
      try {
        expect(await client.listTools()).toEqual([]);
        await vi.waitFor(() => expect(lines.filter(line => line.startsWith('warn: MCP stderr:')))
          .toEqual(['warn: MCP stderr: backend 中文告警']), { timeout: 5000 });
      } finally { await client.disconnect(); }
      await vi.waitFor(() => expect(lines).toContain('info: MCP stderr reader terminated'), { timeout: 5000 });
    });
  });

  it('the real frontend session monitors child stderr only once', async () => {
    await withScript(String.raw`process.stderr.write('session 告警\n'); process.stdout.write('{}\n');`, async script => {
      const { lines, log } = logs();
      let resolveClosed!: () => void;
      const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
      const manager = new StdioSessionManager(event => { if (event.endsWith('-closed')) resolveClosed(); }, log);
      try {
        await manager.start(runtime.command, [script], runtime.env, 'jsonl', null);
        await closed;
        await vi.waitFor(() => expect(lines).toContain('info: MCP stderr reader terminated'), { timeout: 5000 });
        expect(lines.filter(line => line.startsWith('warn: MCP stderr:'))).toEqual(['warn: MCP stderr: session 告警']);
      } finally { await manager.dispose(); }
    });
  });

  it.each(['session', 'backend'] as const)('%s retains real stderr logs when stdin EOF follows host dispose', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-dispose-stderr-'));
    const paths = createPaths({ dataDir: root, platform: 'linux', env: { HOME: root, XDG_DATA_HOME: root } });
    const log = createLogService({ paths, debug: false, version: 'test' });
    const script = join(root, 'dispose-child.cjs');
    // The child cannot emit this tail until production close has ended stdin. No sleep or
    // fake reader/logger: the EOF orders shutdown before the final real pipe reads.
    await writeFile(script, String.raw`
const readline = require('node:readline');
require('node:fs').writeFileSync(process.argv[1] + '.pid', String(process.pid));
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const message = JSON.parse(line);
  if (message.id == null) return;
  const result = { protocolVersion: message.params.protocolVersion, capabilities: {}, serverInfo: { name: 'dispose', version: '1' } };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
});
rl.on('close', () => {
  process.stderr.write(Buffer.concat([Buffer.from('shutdown 中文告警\n'), Buffer.from([0xff, 0x0a])]), () => process.exit(0));
});
process.stdout.write(JSON.stringify({ pid: process.pid }) + '\n');
`);
    const entry = { id: 'dispose-fixture', name: 'dispose-fixture', enabled: true, transportType: 'stdio',
      command: runtime.command, args: [script], env: runtime.env, cwd: root, framing: 'jsonl' };
    const values = new Map([['mcp.tools.list', JSON.stringify([entry])]]);
    const host = await createTestHost({ app: { dataDir: root }, provide: {
      log, settings: { get: (key: string) => values.get(key) ?? null,
        getSecret: async (key: string) => values.get(key) ?? null },
      secrets: {}, llm: {}, webSearch: {},
    }, plugins: [mcpPlugin] });
    let disposed = false;
    try {
      if (mode === 'session') {
        const id = await host.invoke<string>('mcp_stdio_start', entry);
        await vi.waitFor(() => expect(host.eventsNamed(`mcp-stdio-${id}-message`)).toHaveLength(1), { timeout: 5000 });
      } else {
        const config = defaultMcpConfig();
        config.transport = { type: 'stdio', command: runtime.command, args: [script], env: runtime.env, framing: 'jsonl' };
        await host.ctx.mcp.initializeGlobalClient(config);
      }
      log.logger('fixture').info('host dispose begins');
      const pid = Number(await readFile(`${script}.pid`, 'utf8'));
      await host.dispose();
      disposed = true;
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
      const target = mode === 'session' ? 'dstu_mcp::mcp::stdio_proxy' : 'dstu_mcp::mcp';
      await vi.waitFor(async () => {
        const text = await readFile(log.mainLogFile, 'utf8');
        const tail = text.slice(text.indexOf('[INFO][fixture] host dispose begins'));
        expect(tail).toContain(`[WARN][${target}] MCP stderr: shutdown 中文告警`);
        expect(tail).toContain(`[ERROR][${target}] Error reading from MCP stderr: stream did not contain valid UTF-8`);
        expect(tail.match(/MCP stderr reader terminated/g)).toHaveLength(1);
        expect(tail).toContain(`[INFO][${target}] MCP stdout reader terminated`);
        expect(tail).toContain(`[INFO][${target}] MCP child process exited gracefully on close()`);
      }, { timeout: 5000 });
      expect(host.events.filter(event => event.event.endsWith('-closed') || event.event.endsWith('-error'))).toEqual([]);
    } finally {
      if (!disposed) await host.dispose();
      await log.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

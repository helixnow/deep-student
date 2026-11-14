import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { defaultToolConfig, doSearch, type SearchInput } from '../api.ts';
import mcpPlugin from '../index.ts';
import { createTransportForConfig } from '../src/probe.ts';
import { currentStdioRuntime } from '../equivalence/runtime.ts';

const runtime = currentStdioRuntime();

type Framing = 'jsonl' | 'content_length';
interface StdoutCase {
  name: string;
  framing: Framing;
  bytes: Buffer;
  messages: string[];
  error: string | null;
  earlyWarning: boolean;
  preview?: string;
}
const bad = Buffer.from([0xff]);
const firstHeader = 'Content-Length: 1';
const firstJson = '{"id":1}';
const chineseJson = '  {"text":"中文"}';
const bomBody = '\ufeff{"text":"中文"}';
const cases: StdoutCase[] = [
  { name: 'JSONL invalid line', framing: 'jsonl', bytes: Buffer.concat([bad, Buffer.from('\n{"late":true}\n')]), messages: [],
    error: 'Error reading from MCP stdout (JSONL): stream did not contain valid UTF-8', earlyWarning: true },
  { name: 'JSONL valid prefix then invalid line', framing: 'jsonl', bytes: Buffer.concat([Buffer.from(`${firstJson}\n`), bad, Buffer.from('\n{"late":true}\n')]), messages: [firstJson],
    error: 'Error reading from MCP stdout (JSONL): stream did not contain valid UTF-8', earlyWarning: false },
  { name: 'JSONL incomplete UTF-8 at EOF', framing: 'jsonl', bytes: Buffer.from([0xe4, 0xb8]), messages: [],
    error: 'Error reading from MCP stdout (JSONL): stream did not contain valid UTF-8', earlyWarning: true },
  { name: 'configured Content-Length invalid body', framing: 'content_length', bytes: Buffer.concat([Buffer.from(`${firstHeader}\r\n\r\n`), bad]), messages: [],
    error: 'Error reading from MCP stdout (Content-Length): Invalid UTF-8 in message body: invalid utf-8 sequence of 1 bytes from index 0', earlyWarning: false },
  { name: 'complete Content-Length frame with incomplete UTF-8 body', framing: 'content_length', bytes: Buffer.concat([Buffer.from('Content-Length: 2\r\n\r\n'), Buffer.from([0xe4, 0xb8])]), messages: [],
    error: 'Error reading from MCP stdout (Content-Length): Invalid UTF-8 in message body: incomplete utf-8 byte sequence from index 0', earlyWarning: false },
  { name: 'configured Content-Length invalid header', framing: 'content_length', bytes: Buffer.concat([bad, Buffer.from(`\n${firstHeader}\r\n\r\nx`)]), messages: [],
    error: 'Error reading from MCP stdout (Content-Length): stream did not contain valid UTF-8', earlyWarning: false },
  { name: 'Content-Length to JSONL invalid subsequent line', framing: 'content_length', bytes: Buffer.concat([Buffer.from(`${firstJson}\n`), bad, Buffer.from('\n{"late":true}\n')]), messages: [firstJson],
    error: 'Error reading from MCP stdout (JSONL fallback): stream did not contain valid UTF-8', earlyWarning: false },
  { name: 'JSONL to Content-Length invalid first body', framing: 'jsonl', bytes: Buffer.concat([Buffer.from(`${firstHeader}\r\n\r\n`), bad]), messages: [],
    error: 'Invalid UTF-8 in fallback body: invalid utf-8 sequence of 1 bytes from index 0', earlyWarning: true, preview: firstHeader },
  { name: 'JSONL to Content-Length invalid remaining header', framing: 'jsonl', bytes: Buffer.concat([Buffer.from(`${firstHeader}\r\n`), bad, Buffer.from('\n\r\nx')]), messages: [],
    error: 'Error reading fallback header: stream did not contain valid UTF-8', earlyWarning: true, preview: firstHeader },
  { name: 'configured Content-Length incomplete body', framing: 'content_length', bytes: Buffer.from('Content-Length: 3\r\n\r\na'), messages: [],
    error: 'Error reading from MCP stdout (Content-Length): early eof', earlyWarning: false },
  { name: 'JSONL to Content-Length incomplete first body', framing: 'jsonl', bytes: Buffer.from('Content-Length: 3\r\n\r\na'), messages: [],
    error: 'Error reading fallback body: early eof', earlyWarning: true, preview: 'Content-Length: 3' },
  { name: 'JSONL preserves leading whitespace and trims Rust trailing whitespace', framing: 'jsonl', bytes: Buffer.from(`${chineseJson}\u0085\n`), messages: [chineseJson],
    error: null, earlyWarning: false },
  { name: 'Content-Length preserves raw UTF-8 body including BOM', framing: 'content_length', bytes: Buffer.from(`Content-Length: ${Buffer.byteLength(bomBody)}\r\n\r\n${bomBody}`), messages: [bomBody],
    error: null, earlyWarning: false },
  { name: 'Content-Length to JSONL trims first line but not subsequent leading whitespace or FEFF', framing: 'content_length', bytes: Buffer.from(` \u0085${firstJson}\u0085 \n  {"id":2}\ufeff\n`), messages: [firstJson, '  {"id":2}\ufeff'],
    error: null, earlyWarning: false },
];

async function sessionCase(input: StdoutCase) {
  const host = await createTestHost();
  const script = join(host.app.dataDir, 'stdout-child.cjs');
  const logs: { level: string; message: string }[] = [];
  let id: string | undefined;
  try {
    await writeFile(script, `process.stdout.write(Buffer.from(${JSON.stringify([...input.bytes])}));`);
    const values = new Map<string, string>([['mcp.tools.list', JSON.stringify([{
      id: 'stdout-fixture', name: 'stdout-fixture', transportType: 'stdio', enabled: true,
      command: runtime.command, args: [script], env: runtime.env, cwd: host.app.dataDir, framing: input.framing,
    }])]]);
    host.ctx.provide('settings', { get: (key: string) => values.get(key) ?? null,
      save: (key: string, value: string) => { values.set(key, value); },
      getSecret: async (key: string) => values.get(key) ?? null,
      saveSecret: async (key: string, value: string) => { values.set(key, value); },
    });
    // Dormant dependencies fail if accidentally used; parsing, authorization and stdio are production code.
    host.ctx.provide('secrets', {});
    host.ctx.provide('llm', {});
    host.ctx.provide('webSearch', {
      doSearch: (query: SearchInput, signal?: AbortSignal) => doSearch(defaultToolConfig(), query, () => undefined, signal),
    });
    host.ctx.provide('log', { logger: () => ({
      warn: (message: string) => logs.push({ level: 'warn', message }),
      error: (message: string) => logs.push({ level: 'error', message }),
      info: (message: string) => logs.push({ level: 'info', message }),
    }) });
    await host.install(mcpPlugin);
    // Go through the real allowlist, spawn and window-event production entry.
    id = await host.invoke<string>('mcp_stdio_start', { command: runtime.command, args: [script],
      env: runtime.env, cwd: host.app.dataDir, framing: input.framing });
    const prefix = `mcp-stdio-${id}`;
    await vi.waitFor(() => expect(host.eventsNamed(`${prefix}-closed`)).toHaveLength(1), { timeout: 5000 });
    expect(host.eventsNamed(`${prefix}-message`)).toEqual(input.messages.map(message => ({ message })));
    expect(host.eventsNamed(`${prefix}-error`)).toEqual([{ error: 'Transport error: Channel closed' }]);
    expect(host.eventsNamed(`${prefix}-closed`)).toEqual([{}]);
    expect(logs.filter(line => line.level === 'error').map(line => line.message)).toEqual(input.error === null ? [] : [input.error]);
    const early = logs.find(line => line.message.startsWith('MCP stdout EOF before any message:'));
    if (input.earlyWarning) {
      expect(early?.level).toBe('warn');
      expect(early?.message).toContain(`pre_first_message_bytes=${Buffer.byteLength(input.preview ?? '')} preview=${JSON.stringify(input.preview ?? '')}`);
    } else expect(early).toBeUndefined();
    const names = host.events.map(event => event.event).filter(event => event.startsWith(prefix));
    expect(names).toEqual([...input.messages.map(() => `${prefix}-message`), `${prefix}-error`, `${prefix}-closed`]);
    const terminated = logs.findIndex(line => line.message === 'MCP stdout reader terminated');
    const cleaned = logs.findIndex(line => line.message === `MCP stdio session ${id} auto-cleaned after reader exit`);
    expect(terminated).toBeGreaterThanOrEqual(0);
    expect(cleaned).toBeGreaterThan(terminated);
    await expect(host.invoke('mcp_stdio_send', { sessionId: id, payload: '{}' })).rejects.toEqual({
      // cmd/mcp.rs:645 internal(Display), models.rs:1006-1007 maps internal to AppErrorType::Unknown.
      error_type: 'Unknown', message: `Transport error: Unknown session: ${id}`, details: null,
    });
  } finally {
    if (id !== undefined) await host.invoke('mcp_stdio_close', { sessionId: id });
    await host.dispose();
  }
}

describe('global.rs stdout UTF-8/framing termination via real mcp_stdio_start', () => {
  it.each(cases)('$name', sessionCase);
});

describe('global.rs backend stdout uses the same producer/channel terminal', () => {
  it('drains valid buffered messages before channel close and never forwards the invalid or later line', async () => {
    const host = await createTestHost();
    const script = join(host.app.dataDir, 'backend-buffered-stdout.cjs');
    const bytes = Buffer.concat([Buffer.from(`${firstJson}\n`), bad, Buffer.from('\n{"late":true}\n')]);
    await writeFile(script, `process.stdin.once('data', () => process.stdout.write(Buffer.from(${JSON.stringify([...bytes])}), () => process.exit(0)));`);
    const logs: string[] = [];
    try {
      const transport = await createTransportForConfig({ type: 'stdio', command: runtime.command, args: [script], framing: 'jsonl', env: runtime.env },
        (level, message) => logs.push(`${level}: ${message}`));
      try {
        await transport.send('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}');
        await vi.waitFor(() => expect(logs).toContain('info: MCP stdout reader terminated'), { timeout: 5000 });
        expect(await transport.receive()).toBe(firstJson);
        await expect(transport.receive()).rejects.toThrow('Transport error: Channel closed');
      } finally { await transport.close(); }
    } finally { await host.dispose(); }
  });

  it.each(['jsonl', 'content_length'] as const)('%s rejects a pending receive on invalid stdout, without a timer change', async framing => {
    const host = await createTestHost();
    const script = join(host.app.dataDir, 'backend-bad-stdout.cjs');
    const bytes = framing === 'jsonl' ? Buffer.from([0xff, 0x0a]) : Buffer.concat([Buffer.from(`${firstHeader}\r\n\r\n`), bad]);
    await writeFile(script, `process.stdin.once('data', () => process.stdout.write(Buffer.from(${JSON.stringify([...bytes])}), () => process.exit(0)));`);
    const logs: string[] = [];
    try {
      const transport = await createTransportForConfig({ type: 'stdio', command: runtime.command, args: [script], framing, env: runtime.env },
        (level, message) => logs.push(`${level}: ${message}`));
      try {
        const pending = transport.receive();
        const closed = expect(pending).rejects.toThrow('Transport error: Channel closed');
        await transport.send('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}');
        await closed;
        expect(logs.some(line => line.startsWith('error: Error reading from MCP stdout'))).toBe(true);
        expect(logs).toContain('info: MCP stdout reader terminated');
      } finally { await transport.close(); }
    } finally { await host.dispose(); }
  });
});

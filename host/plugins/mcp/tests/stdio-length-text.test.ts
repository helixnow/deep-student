import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { defaultToolConfig, doSearch, type SearchInput } from '../api.ts';
import mcpPlugin from '../index.ts';
import { parseUsizeText, USIZE_BITS, USIZE_MAX, usizeErrorMessage } from '../src/usize-text.ts';
import { currentStdioRuntime } from '../equivalence/runtime.ts';

const runtime = currentStdioRuntime();

type Framing = 'jsonl' | 'content_length';
interface LengthCase {
  name: string;
  framing: Framing;
  bytes: Buffer;
  messages: string[];
  error: string | null;
}
const cases: LengthCase[] = [];
const invalidDigit = 'Invalid Content-Length value: invalid digit found in string';
const overflow = 'Invalid Content-Length value: number too large to fit in target type';
const badHeader = Buffer.from([0xff, 0x0a]);
const configuredError = (message: string) => `Error reading from MCP stdout (Content-Length): ${message}`;
const fallbackInvalid = (debug: string) => `Invalid Content-Length in fallback first line: ${debug}`;

for (const value of ['2e0', '2.0', '0x2', '0b10', '0o2', '-0', '+', '2x']) {
  for (const framing of ['content_length', 'jsonl'] as const) {
    cases.push({ name: `${framing} rejects ${value}`, framing,
      bytes: Buffer.from(`Content-Length: ${value}\r\n\r\n{}`), messages: [],
      error: framing === 'content_length' ? configuredError(invalidDigit) : fallbackInvalid(`"${value}"`) });
  }
}
for (const framing of ['content_length', 'jsonl'] as const) {
  cases.push({ name: `${framing} rejects FEFF rather than letting Number trim it`, framing,
    bytes: Buffer.from('Content-Length: \ufeff2\r\n\r\n{}'), messages: [],
    error: framing === 'content_length' ? configuredError(invalidDigit) : fallbackInvalid('"\\u{feff}2"') });
  cases.push({ name: `${framing} accepts optional plus and leading zero`, framing,
    bytes: Buffer.from('Content-Length: +02\r\n\r\n{}'), messages: ['{}'], error: null });
  cases.push({ name: `${framing} accepts outer Rust whitespace including NEL`, framing,
    bytes: Buffer.from('Content-Length: \u0085+02\u0085\r\n\r\n{}'), messages: ['{}'], error: null });
  cases.push({ name: `${framing} zero has its original contextual error`, framing,
    bytes: Buffer.from('Content-Length: 0\r\n\r\n'), messages: [],
    error: framing === 'content_length' ? configuredError('Missing or invalid Content-Length header') : fallbackInvalid('"0"') });
  cases.push({ name: `${framing} empty value has its original contextual error`, framing,
    bytes: Buffer.from('Content-Length: \r\n\r\n'), messages: [],
    error: framing === 'content_length' ? configuredError('Missing or invalid Content-Length header') : fallbackInvalid('""') });
  const value = (USIZE_MAX + 1n).toString();
  cases.push({ name: `${framing} reports usize overflow`, framing,
    bytes: Buffer.from(`Content-Length: ${value}\r\n\r\n`), messages: [],
    error: framing === 'content_length' ? configuredError(overflow) : fallbackInvalid(`"${value}"`) });
}

// No body is supplied: configured frames must reject exactly, before any body read/allocation.
for (const value of [104857601n, 9007199254740992n, 9007199254740993n, USIZE_MAX]) {
  cases.push({ name: `configured exact large value ${value} without a body`, framing: 'content_length',
    bytes: Buffer.from(`Content-Length: ${value}\r\n\r\n`), messages: [],
    error: configuredError(value > USIZE_MAX ? overflow
      : `Message size ${value} exceeds maximum allowed size 104857600`) });
}

// Prove parse/header order without reaching the fallback Vec/Node allocation seam.
cases.push({ name: 'configured reads the complete header block before parsing an invalid length', framing: 'content_length',
  bytes: Buffer.concat([Buffer.from('Content-Length: 2e0\r\nX-Bad: '), badHeader, Buffer.from('\r\n{}')]), messages: [],
  error: configuredError('stream did not contain valid UTF-8') });
cases.push({ name: 'fallback rejects invalid length before reading a bad remaining header', framing: 'jsonl',
  bytes: Buffer.concat([Buffer.from('Content-Length: 2e0\r\nX-Bad: '), badHeader, Buffer.from('\r\n{}')]), messages: [],
  error: fallbackInvalid('"2e0"') });
cases.push({ name: 'configured header EOF wins before invalid length parsing', framing: 'content_length',
  bytes: Buffer.from('Content-Length: 2e0\r\n'), messages: [], error: null });
cases.push({ name: 'fallback parses invalid length before remaining-header EOF', framing: 'jsonl',
  bytes: Buffer.from('Content-Length: 2e0\r\n'), messages: [], error: fallbackInvalid('"2e0"') });

for (const value of [104857601n, USIZE_MAX]) {
  cases.push({ name: `fallback legal ${value} reaches remaining header, not a new size cap`, framing: 'jsonl',
    bytes: Buffer.concat([Buffer.from(`Content-Length: ${value}\r\nX-Bad: `), badHeader, Buffer.from('\r\n')]), messages: [],
    error: 'Error reading fallback header: stream did not contain valid UTF-8' });
}

async function checkCase(input: LengthCase) {
  const host = await createTestHost();
  const script = join(host.app.dataDir, 'length-child.cjs');
  const logs: { level: string; message: string }[] = [];
  let id: string | undefined;
  try {
    await writeFile(script, `process.stdout.write(Buffer.from(${JSON.stringify([...input.bytes])}));`);
    const values = new Map([['mcp.tools.list', JSON.stringify([{
      id: 'length-fixture', name: 'length-fixture', enabled: true, transportType: 'stdio',
      command: runtime.command, args: [script], env: runtime.env, cwd: host.app.dataDir, framing: input.framing,
    }])]]);
    host.ctx.provide('settings', {
      get: (key: string) => values.get(key) ?? null,
      save: (key: string, value: string) => { values.set(key, value); },
      getSecret: async (key: string) => values.get(key) ?? null,
      saveSecret: async (key: string, value: string) => { values.set(key, value); },
    });
    host.ctx.provide('secrets', {});
    host.ctx.provide('llm', {});
    host.ctx.provide('webSearch', {
      doSearch: (query: SearchInput, signal?: AbortSignal) => doSearch(defaultToolConfig(), query, () => undefined, signal),
    });
    host.ctx.provide('log', { logger: () => ({
      info: (message: string) => logs.push({ level: 'info', message }),
      warn: (message: string) => logs.push({ level: 'warn', message }),
      error: (message: string) => logs.push({ level: 'error', message }),
    }) });
    await host.install(mcpPlugin);
    id = await host.invoke<string>('mcp_stdio_start', { command: runtime.command, args: [script],
      env: runtime.env, cwd: host.app.dataDir, framing: input.framing });
    const prefix = `mcp-stdio-${id}`;
    await vi.waitFor(() => expect(host.eventsNamed(`${prefix}-closed`)).toHaveLength(1), { timeout: 5000 });
    expect(host.eventsNamed(`${prefix}-message`)).toEqual(input.messages.map(message => ({ message })));
    expect(logs.filter(line => line.level === 'error').map(line => line.message)).toEqual(input.error === null ? [] : [input.error]);
    expect(host.eventsNamed(`${prefix}-error`)).toEqual([{ error: 'Transport error: Channel closed' }]);
    expect(host.eventsNamed(`${prefix}-closed`)).toEqual([{}]);
    await expect(host.invoke('mcp_stdio_send', { sessionId: id, payload: '{}' })).rejects.toEqual({
      error_type: 'Unknown', message: `Transport error: Unknown session: ${id}`, details: null,
    });
  } finally {
    if (id !== undefined) await host.invoke('mcp_stdio_close', { sessionId: id });
    await host.dispose();
  }
}

describe('Content-Length integer text and original parse order (new scope, not stdout UTF-8 replay)', () => {
  it('classifies Rust ParseIntError before contextual framing decisions', () => {
    expect(parseUsizeText('')).toEqual({ ok: false, kind: 'Empty' });
    for (const text of ['+', '-0', '2.0', '2e0', '0x2', '\ufeff2', '2 ', `${USIZE_MAX}x`]) {
      expect(parseUsizeText(text), text).toEqual({ ok: false, kind: 'InvalidDigit' });
    }
    expect(parseUsizeText(`${USIZE_MAX + 1n}x`)).toEqual({ ok: false, kind: 'PosOverflow' });
    expect(parseUsizeText('+02')).toEqual({ ok: true, value: 2n });
    expect(parseUsizeText(USIZE_MAX.toString())).toEqual({ ok: true, value: USIZE_MAX });
    expect(usizeErrorMessage('Empty')).toBe('cannot parse integer from empty string');
    expect(usizeErrorMessage('InvalidDigit')).toBe('invalid digit found in string');
    expect(usizeErrorMessage('PosOverflow')).toBe('number too large to fit in target type');
    if (process.arch === 'x64' || process.arch === 'arm64') {
      expect(USIZE_BITS).toBe(64);
      expect(USIZE_MAX).toBe(18446744073709551615n);
    } else if (process.arch === 'ia32' || process.arch === 'arm') {
      expect(USIZE_BITS).toBe(32);
      expect(USIZE_MAX).toBe(4294967295n);
    }
  });
  it.each(cases)('$name', checkCase);
});

/**
 * How the MCP debug panel shows and copies event details that are not a plain object.
 */
import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import McpDebugPlugin from '../plugins/McpDebugPlugin';
import { sanitizeDetails, truncateData } from '../plugins/mcp/sanitize';

const h = vi.hoisted(() => ({ copied: [] as string[] }));

vi.mock('@/utils/clipboardUtils', () => ({
  copyTextToClipboard: vi.fn(async (text: string) => {
    h.copied.push(text);
    return true;
  }),
}));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));

afterEach(() => {
  cleanup();
  h.copied.length = 0;
});

async function panelWith(name: string, detail: unknown) {
  const view = render(<McpDebugPlugin visible isActive isActivated onClose={() => undefined} />);
  await act(async () => {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  });
  await act(async () => {
    fireEvent.click(view.container.querySelector<HTMLButtonElement>('button[title="复制日志"]')!);
  });
  return {
    shown: view.container.querySelector('details pre')?.textContent,
    copied: JSON.parse(h.copied.at(-1)!).details,
  };
}

describe('MCP debug panel details', () => {
  // Tauri showed and copied this detail as {"0":"[","1":"对","2":"象",…}, one key per character.
  it('RF-W19-mcp-details-char-indexed: shows an over-long config change as one truncated message, not a map of its characters', async () => {
    const detail = { servers: 2, note: 'x'.repeat(620) };
    const message = `[对象过大: ${JSON.stringify(detail).length} 字符, 已截断]`;

    const { shown, copied } = await panelWith('mcp-config-change', detail);

    expect(copied).toBe(message);
    expect(shown).toBe(JSON.stringify(message, null, 2));
  });

  // Long strings are spaced: an unbroken run of 21+ letters and digits is masked as a key before truncation.
  it('RF-W19-mcp-details-char-indexed: keeps array details an array, each item sanitized and truncated', () => {
    const long = 'word '.repeat(104);

    expect(sanitizeDetails([{ id: 'fs', token: 'tok-12345678' }, long, 3])).toEqual([
      { id: 'fs', token: '***5678 [已脱敏]' },
      `${long.slice(0, 500)}... [截断 20 字符]`,
      3,
    ]);
  });

  it('RF-W19-mcp-details-char-indexed: truncates and masks a string detail as a whole', () => {
    const long = 'line '.repeat(102);

    expect(sanitizeDetails(long)).toBe(`${long.slice(0, 500)}... [截断 10 字符]`);
    expect(sanitizeDetails('abcdefghijklmnopqrstuvwxyz0123')).toBe('abcdef***0123 [已脱敏]');
  });

  it('still masks and truncates object details key by key', () => {
    const long = 'data '.repeat(101);

    expect(sanitizeDetails({ transport: 'sse', password: 'hunter22', payload: long })).toEqual({
      transport: 'sse',
      password: '***er22 [已脱敏]',
      payload: `${long.slice(0, 500)}... [截断 5 字符]`,
    });
    expect(truncateData({ list: [1, 2] })).toEqual({ list: [1, 2] });
  });
});

describe('MCP debug panel masking', () => {
  // Tauri compared the lowercased key with 'apiKey', which never matched: `sk-short` was shown and copied as is.
  it('RF-W19-mcp-api-key-field-unmasked: masks an apiKey field whatever its value looks like', async () => {
    const { shown, copied } = await panelWith('mcp-tool-call-start', {
      serverId: 'fs', toolName: 'search', callId: 'call-1', args: { apiKey: 'sk-short', ApiKey: 'abcdefghijklmnopqrstuvwxyz0123' },
    });

    expect(copied.toolArgs).toEqual({ apiKey: '***hort [已脱敏]', ApiKey: '***0123 [已脱敏]' });
    expect(shown).not.toContain('sk-short');
  });

  it('masks the other listed keys in any case, and long key-like values under any key', () => {
    expect(sanitizeDetails({ API_KEY: 'k1', Token: 't-1', userPassword: 'pw', note: 'abcdefghijklmnopqrstuvwxyz0123', plain: 'sk-short' })).toEqual({
      API_KEY: '***k1 [已脱敏]',
      Token: '***t-1 [已脱敏]',
      userPassword: '***pw [已脱敏]',
      note: 'abcdef***0123 [已脱敏]',
      plain: 'sk-short',
    });
  });
});

describe('MCP debug panel errors', () => {
  const withStack = <E extends Error>(error: E, stack: string) => Object.assign(error, { stack });

  // Tauri wrote `name: message` and then the stack; a Chromium stack (WebView2, Electron) starts with that same line.
  it('RF-W19-mcp-error-message-repeated: shows the name and message line once when the stack starts with it', async () => {
    const error = withStack(new TypeError('fetch failed: ECONNREFUSED'), 'TypeError: fetch failed: ECONNREFUSED\n    at connectSse (mcp/transport.ts:42:7)');

    const { copied } = await panelWith('mcp-connect-fail', { serverId: 'search', transport: 'sse', error });

    expect(copied.error).toBe('TypeError: fetch failed: ECONNREFUSED\n    at connectSse (mcp/transport.ts:42:7)');
  });

  it('RF-W19-mcp-error-message-repeated: shows the line once for an error raised in this runtime', () => {
    const lines = String(truncateData(new RangeError('boom'))).split('\n');

    expect(lines[0]).toBe('RangeError: boom');
    expect(lines.filter((line) => line.includes('boom'))).toHaveLength(1);
  });

  it('RF-W19-mcp-error-message-repeated: drops the repeated line for an error without a message', () => {
    expect(truncateData(withStack(new Error(''), 'Error\n    at probe (a.ts:1:1)'))).toBe('Error: \n    at probe (a.ts:1:1)');
  });

  it('still puts the name and message ahead of a stack that does not start with them', () => {
    expect(truncateData(withStack(new TypeError('fetch failed'), 'connectSse@mcp/transport.ts:42:7'))).toBe('TypeError: fetch failed\nconnectSse@mcp/transport.ts:42:7');
    const renamed = withStack(new Error('old'), 'Error: old\n    at probe (a.ts:1:1)');
    renamed.message = 'new';
    expect(truncateData(renamed)).toBe('Error: new\nError: old\n    at probe (a.ts:1:1)');
  });
});

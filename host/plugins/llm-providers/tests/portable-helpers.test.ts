/**
 * The portable replacements must stay byte-for-byte equivalent to the Node APIs
 * they replaced (`Buffer` base64, `http.validateHeaderValue`, `util.inspect.custom`).
 */
import { validateHeaderValue as nodeValidateHeaderValue } from 'node:http';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { decodeBase64Url, encodeBase64, encodeBase64Url } from '../api.ts';
import { validateHeaderValue } from '../src/openai-codex/header-value.ts';
import { StoredCodexSession } from '../src/openai-codex/types.ts';

function samples(): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let length = 0; length <= 7; length += 1) out.push(Uint8Array.from({ length }, (_, i) => (i * 97 + length * 31) & 0xff));
  out.push(Uint8Array.from({ length: 256 }, (_, i) => i));
  out.push(Uint8Array.from({ length: 70_001 }, (_, i) => (i * 7919) & 0xff));
  return out;
}

describe('portable base64 helpers', () => {
  it('match Buffer base64 / base64url encoding and decoding', () => {
    for (const bytes of samples()) {
      expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
      const url = encodeBase64Url(bytes);
      expect(url).toBe(Buffer.from(bytes).toString('base64url'));
      expect([...decodeBase64Url(url)]).toEqual([...Buffer.from(url, 'base64url')]);
    }
  });

  it('round-trips UTF-8 tool names exactly like Buffer', () => {
    const text = 'mcp/搜索 工具🙂';
    const url = encodeBase64Url(new TextEncoder().encode(text));
    expect(url).toBe(Buffer.from(text, 'utf8').toString('base64url'));
    expect(new TextDecoder().decode(decodeBase64Url(url))).toBe(text);
  });
});

describe('portable header value validation', () => {
  it('accepts and rejects exactly the characters node:http does, with the same error name', () => {
    for (let code = 0; code <= 0x10ffff; code += code < 0x200 ? 1 : 0x101) {
      const value = `a${String.fromCodePoint(code)}b`;
      let nodeError: unknown = null;
      let ownError: unknown = null;
      try { nodeValidateHeaderValue('x-test', value); } catch (error) { nodeError = error; }
      try { validateHeaderValue('x-test', value); } catch (error) { ownError = error; }
      expect(ownError === null, `U+${code.toString(16)}`).toBe(nodeError === null);
      if (nodeError instanceof Error) expect((ownError as Error).name).toBe(nodeError.name);
    }
  });
});

describe('codex session redaction', () => {
  it('keeps the util.inspect redaction hook', () => {
    const session = new StoredCodexSession({
      schemaVersion: 1, accessToken: 'secret-access', refreshToken: 'secret-refresh', idToken: 'secret-id',
      expiresAtUnixMs: 1n, accountId: 'acct-123456789', email: null, planType: null, isFedramp: false, lastRefreshAt: null,
    });
    const rendered = inspect(session);
    expect(rendered).not.toContain('secret-');
    expect(rendered).toContain('[REDACTED]');
  });
});

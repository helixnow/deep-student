/**
 * 凭据脱敏（redact.ts）是可移植的：移动端日志服务与前端可直接复用，运行时闭包不触达 Node 专有依赖
 * （用可移植性扫描器的同一闭包分析检查）。`scrubPii` 的平台由调用方的平台入口给出。
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkModulesClosure } from '../../../../scripts/portability/lib/portability.mjs';
import { sanitizeForLevel, scrubPii } from '../redact.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

describe('portable redact.ts', () => {
  it('has a Node-free runtime closure', () => {
    expect(checkModulesClosure(ROOT, ['host/platform/log/redact.ts'])).toEqual([]);
  });

  it('counts content_size in UTF-8 bytes (Rust str::len), lone surrogates as U+FFFD', () => {
    const body = { messages: [{ role: 'user', content: 'é中😀\ud800' }] };
    const out = sanitizeForLevel(body, 'compact') as { messages_summary: { content_size: number }[] };
    expect(out.messages_summary[0]!.content_size).toBe(Buffer.byteLength('é中😀\ud800', 'utf8'));
  });

  it('scrubPii takes the platform from the caller', () => {
    expect(scrubPii('at /home/ann/x', 'android')).toBe('at /<REDACTED>/x');
    expect(scrubPii('D:\\Users\\ann\\x', 'win32')).toBe('C:\\Users\\<REDACTED>\\x');
  });
});

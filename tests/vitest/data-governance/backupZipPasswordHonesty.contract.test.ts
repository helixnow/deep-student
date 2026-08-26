import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readJson = (path: string) =>
  JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8')) as {
    governance: Record<string, string>;
  };

const zh = readJson('src/locales/zh-CN/data.json').governance;
const en = readJson('src/locales/en-US/data.json').governance;
const claimKeys = [
  'export_warning_encrypted',
  'e2ee_password_label',
  'e2ee_password_hint',
  'e2ee_export_note',
] as const;

describe('local backup ZIP password honesty contract', () => {
  it('does not describe the plaintext outer ZIP as end-to-end encrypted', () => {
    const zhClaims = claimKeys.map((key) => zh[key]).join('\n');
    const enClaims = claimKeys.map((key) => en[key]).join('\n');

    expect(zhClaims).not.toContain('端到端加密');
    expect(enClaims).not.toMatch(/end-to-end encrypt/i);
  });

  it('states what is protected, what remains readable, and the real password-loss impact', () => {
    expect(zh.export_warning_encrypted).toContain('只加密保护');
    expect(zh.export_warning_encrypted).toContain('归档内容本身未加密');
    expect(zh.export_warning_encrypted).toContain('请勿通过不可信渠道传播');
    expect(zh.export_warning_encrypted).toContain('业务数据仍可读取');
    expect(zh.export_warning_encrypted).not.toContain('密码丢失将无法解密');

    expect(en.export_warning_encrypted).toMatch(/encrypts only sensitive material/i);
    expect(en.export_warning_encrypted).toMatch(/archive content .* is not encrypted/i);
    expect(en.export_warning_encrypted).toMatch(/untrusted channels/i);
    expect(en.export_warning_encrypted).toMatch(/business data remains readable/i);
  });
});

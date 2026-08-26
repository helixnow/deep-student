import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readJson = (path: string) =>
  JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8')) as {
    governance: Record<string, string>;
  };

const readCloudErrors = (path: string) =>
  (
    JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8')) as {
      errors: Record<string, string>;
    }
  ).errors;

const readText = (path: string) =>
  readFileSync(resolve(process.cwd(), path), 'utf8');

const zh = readJson('src/locales/zh-CN/data.json').governance;
const en = readJson('src/locales/en-US/data.json').governance;
const zhCloudErrors = readCloudErrors('src/locales/zh-CN/cloudStorage.json');
const enCloudErrors = readCloudErrors('src/locales/en-US/cloudStorage.json');
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

  it('cloud restore refusal advice does not call the local export an encrypted ZIP', () => {
    // localizeCloudError.ts 把该键作为便携归档拒绝整槽恢复的补救指引展示；
    // 其中「导出备份」补救指向的是外层明文的本地 ZIP，不得宣称加密。
    expect(zhCloudErrors.partialArchiveNotSlotable).not.toContain('加密全保真');
    expect(zhCloudErrors.partialArchiveNotSlotable).toContain('受保护敏感材料');
    expect(enCloudErrors.partialArchiveNotSlotable).not.toMatch(
      /encrypted full-fidelity/i,
    );
    expect(enCloudErrors.partialArchiveNotSlotable).toMatch(
      /protected sensitive material/i,
    );
  });

  it('user guides stop claiming the local export ZIP is undecryptable without the password', () => {
    const guide16 = readText('docs/user-guide/16-数据管理与云同步.md');
    const guide17 = readText('docs/user-guide/17-移动端指南.md');

    // 指南引用的导出密码标签必须与 UI 实际标签同步（旧标签宣称端到端加密）。
    expect(guide16).toContain(zh.e2ee_password_label);
    expect(guide16).not.toContain('端到端加密，可选');
    // 云端 DSBK 包「永远无法解密」是准确的；被禁的是对本地明文外层 ZIP 的同款宣称。
    expect(guide16).not.toContain('丢失后该 ZIP 将永远无法解密');
    expect(guide16).toContain('归档内容本身未加密');
    expect(guide16).not.toContain('得到加密全保真换机包');
    expect(guide17).not.toContain('把加密全保真 ZIP 导入手机');
  });
});

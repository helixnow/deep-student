import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const plusMenuSource = readFileSync(path.join(here, '../ComposerPlusMenu.tsx'), 'utf8');
const blockingApprovalSource = readFileSync(path.join(here, '../BlockingApprovalBar.tsx'), 'utf8');
const zhLocale = JSON.parse(readFileSync(
  path.join(here, '../../../../../locales/zh-CN/chatV2.json'),
  'utf8',
));
const enLocale = JSON.parse(readFileSync(
  path.join(here, '../../../../../locales/en-US/chatV2.json'),
  'utf8',
));

describe('permission preset source contract', () => {
  it('keeps all fixed preset identifiers and an app-owned danger confirmation', () => {
    for (const preset of ['cautious', 'relaxed', 'full_access', 'danger_full_access']) {
      expect(plusMenuSource).toContain(`'${preset}'`);
      expect(zhLocale.authority.permissionPreset.modes[preset]).toBeTruthy();
      expect(enLocale.authority.permissionPreset.modes[preset]).toBeTruthy();
    }
    expect(plusMenuSource).toContain('<DsAlertDialog');
    expect(plusMenuSource).not.toContain('window.confirm');
  });

  it('exposes session remember but not always/global persistent memory', () => {
    expect(blockingApprovalSource).toContain("'allow_session'");
    expect(blockingApprovalSource).not.toContain("'always_allow'");
    expect(blockingApprovalSource).not.toContain("'always_deny'");
    expect(zhLocale.approval.allowSession).toBeTruthy();
    expect(enLocale.approval.allowSession).toBeTruthy();
    expect(zhLocale.approval.alwaysAllow).toBeUndefined();
    expect(enLocale.approval.alwaysAllow).toBeUndefined();
  });

  it('documents mode precedence and FullAccess privilege-confirmation contract', () => {
    expect(zhLocale.authority.permissionPreset.modePriority).toContain('优先');
    expect(enLocale.authority.permissionPreset.modePriority).toContain('precedence');
    expect(zhLocale.authority.permissionPreset.hints.full_access).toContain('特权仍单次确认');
    expect(zhLocale.authority.permissionPreset.hints.full_access).toContain('灾难命令拒绝');
    expect(zhLocale.authority.permissionPreset.hints.danger_full_access).toContain('特权仍单次确认');
    expect(enLocale.authority.permissionPreset.hints.full_access).toContain('one-shot confirmation');
    expect(enLocale.authority.permissionPreset.hints.full_access).toContain(
      'catastrophic commands are denied',
    );
    expect(enLocale.authority.permissionPreset.hints.danger_full_access).toContain(
      'one-shot confirmation',
    );
  });
});

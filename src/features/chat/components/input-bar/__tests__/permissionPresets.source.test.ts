import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const plusMenuSource = readFileSync(
  new URL('../ComposerPlusMenu.tsx', import.meta.url),
  'utf8',
);
const blockingApprovalSource = readFileSync(
  new URL('../BlockingApprovalBar.tsx', import.meta.url),
  'utf8',
);
const zhLocale = JSON.parse(readFileSync(
  new URL('../../../../../locales/zh-CN/chatV2.json', import.meta.url),
  'utf8',
));
const enLocale = JSON.parse(readFileSync(
  new URL('../../../../../locales/en-US/chatV2.json', import.meta.url),
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

  it('does not expose approval-memory actions that the runtime no longer reads', () => {
    expect(blockingApprovalSource).not.toContain("'allow_session'");
    expect(blockingApprovalSource).not.toContain("'always_allow'");
    expect(blockingApprovalSource).not.toContain("'always_deny'");
    expect(zhLocale.approval.alwaysAllow).toBeUndefined();
    expect(enLocale.approval.alwaysAllow).toBeUndefined();
  });

  it('documents mode precedence and external MCP shell-guard boundaries', () => {
    expect(zhLocale.authority.permissionPreset.modePriority).toContain('优先');
    expect(enLocale.authority.permissionPreset.modePriority).toContain('precedence');
    expect(zhLocale.authority.permissionPreset.hints.full_access).toContain('shell guard');
    expect(enLocale.authority.permissionPreset.hints.full_access).toContain('shell guard');
  });
});

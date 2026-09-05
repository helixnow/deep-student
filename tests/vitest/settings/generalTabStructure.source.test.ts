import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('GeneralTab structure contract', () => {
  it('keeps voice input in its own tab (split out of the general settings page)', () => {
    // 2026-09（265a79bc4）常规页拆分：听写/记忆/工作台移入独立分区薄壳 Tab，
    // GeneralTab 不再内嵌 VoiceInputSettingsSection。
    const source = readFileSync(
      resolve(process.cwd(), 'src/features/settings/components/GeneralTab.tsx'),
      'utf8'
    );
    const voiceTab = readFileSync(
      resolve(process.cwd(), 'src/features/settings/components/VoiceInputTab.tsx'),
      'utf8'
    );

    expect(source).not.toContain('VoiceInputSettingsSection');
    // VoiceInputSettingsSection 自带 GroupTitle 标题，独立页内无需 embedded
    expect(voiceTab).toContain('<VoiceInputSettingsSection assignedModel={voiceInputAssignedModel} />');
    expect(source).toContain("title={t('common:legal.settingsSection.title')}");
    expect(source).toContain("title={t('settings:tabs.general')}");
  });

  it('keeps developer and debugging controls inside the general settings taxonomy', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/features/settings/components/GeneralTab.tsx'),
      'utf8'
    );

    expect(source).toContain("title={t('settings:cards.developer_options_title')}");
    expect(source).toContain("settings:developer.debug_log_switch.title");
    expect(source).toContain("settings:developer.show_raw_request.title");
    expect(source).toContain("settings:developer.persist_logs.title");
  });
});

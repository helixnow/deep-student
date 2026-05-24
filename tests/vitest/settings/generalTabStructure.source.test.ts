import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('GeneralTab structure contract', () => {
  it('embeds voice input into the same grouped shell used by the rest of the general settings page', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/features/settings/components/GeneralTab.tsx'),
      'utf8'
    );

    expect(source).toContain('<VoiceInputSettingsSection embedded assignedModel={voiceInputAssignedModel} />');
    expect(source).toContain('rounded-2xl border border-border/40 bg-background');
    expect(source).toContain("title={t('common:legal.settingsSection.title', '隐私与数据')}");
    expect(source).toContain("title={t('settings:tabs.general', '常规')}");
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

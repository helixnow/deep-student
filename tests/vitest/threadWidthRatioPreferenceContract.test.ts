import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chat thread width ratio preference contract', () => {
  const configSource = readFileSync(
    resolve(process.cwd(), 'src/config/threadWidthConfig.ts'),
    'utf8',
  );
  const shadcnVarsSource = readFileSync(
    resolve(process.cwd(), 'src/styles/shadcn-variables.css'),
    'utf8',
  );
  const beautifySource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/styles/chat-beautify.css'),
    'utf8',
  );
  const appearanceTabSource = readFileSync(
    resolve(process.cwd(), 'src/features/settings/components/AppearanceTab.tsx'),
    'utf8',
  );
  const appInitSource = readFileSync(
    resolve(process.cwd(), 'src/hooks/useAppInitialization.ts'),
    'utf8',
  );
  const zhSettingsSource = readFileSync(
    resolve(process.cwd(), 'src/locales/zh-CN/settings.json'),
    'utf8',
  );
  const enSettingsSource = readFileSync(
    resolve(process.cwd(), 'src/locales/en-US/settings.json'),
    'utf8',
  );

  it('keeps the ratio on the single --chat-thread-max-w token with 44rem floor', () => {
    expect(shadcnVarsSource).toContain('--chat-thread-ratio: 80;');
    expect(shadcnVarsSource).toContain(
      '--chat-thread-max-w: max(44rem, calc(1% * var(--chat-thread-ratio)));',
    );
    expect(configSource).toContain("CHAT_THREAD_WIDTH_RATIO_STORAGE_KEY = 'chat.threadWidthRatio'");
    expect(configSource).toContain("'--chat-thread-ratio'");
    expect(configSource).toContain('DEFAULT_CHAT_THREAD_WIDTH_RATIO = 80');
  });

  it('aligns padding-on-shell surfaces (empty stack / loading skeleton) with the ratio', () => {
    expect(beautifySource).toContain(
      'max-width: max(44rem, calc((100% - 4rem) * var(--chat-thread-ratio, 80) / 100));',
    );
    // 空态布局内层 thread 表面解禁，避免占比逐层收窄
    expect(beautifySource).toContain(
      '.chat-v2 .chat-empty-composer-layout__message-list [data-slot="thread-content-shell"]',
    );
  });

  it('restores the ratio at app startup', () => {
    expect(appInitSource).toContain('initializeThreadWidthRatio');
    expect(appInitSource).toContain('CHAT_THREAD_WIDTH_RATIO_STORAGE_KEY');
    expect(appInitSource).toContain('applyThreadWidthRatioToDocument(normalizeThreadWidthRatio(raw))');
  });

  it('surfaces a persisted slider in appearance settings with rollback', () => {
    expect(appearanceTabSource).toContain('settings:theme.thread_width_ratio_title');
    expect(appearanceTabSource).toContain('settings:theme.thread_width_ratio_description');
    expect(appearanceTabSource).toContain('<SettingsSlider');
    expect(appearanceTabSource).toContain('handleThreadWidthRatioChange');
    expect(appearanceTabSource).toContain('applyThreadWidthRatioToDocument(normalized)');
    expect(appearanceTabSource).toContain('applyThreadWidthRatioToDocument(previousValue)');
    expect(zhSettingsSource).toContain('"thread_width_ratio_title"');
    expect(zhSettingsSource).toContain('"thread_width_ratio_description"');
    expect(enSettingsSource).toContain('"thread_width_ratio_title"');
    expect(enSettingsSource).toContain('"thread_width_ratio_description"');
  });
});

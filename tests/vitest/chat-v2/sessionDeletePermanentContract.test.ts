import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chat session delete contract', () => {
  it('deletes sessions permanently instead of moving them to a hidden trash state', () => {
    const lifecycleSource = readFileSync(
      resolve(process.cwd(), 'src/chat-v2/pages/useSessionLifecycle.ts'),
      'utf8'
    );
    const managementSource = readFileSync(
      resolve(process.cwd(), 'src/chat-v2/hooks/useSessionManagement.ts'),
      'utf8'
    );

    expect(lifecycleSource).toContain("'chat_v2_delete_session'");
    expect(managementSource).toContain("'chat_v2_delete_session'");
    expect(lifecycleSource).not.toContain("'chat_v2_soft_delete_session'");
    expect(managementSource).not.toContain("'chat_v2_soft_delete_session'");
  });

  it('does not expose the obsolete trash management hook', () => {
    const hooksIndexSource = readFileSync(
      resolve(process.cwd(), 'src/chat-v2/hooks/index.ts'),
      'utf8'
    );

    expect(hooksIndexSource).not.toContain('useTrashManagement');
    expect(existsSync(resolve(process.cwd(), 'src/chat-v2/hooks/useTrashManagement.ts'))).toBe(false);
  });

  it('uses permanent delete for debug cleanup helpers', () => {
    const cleanupFiles = [
      'src/chat-v2/debug/multiVariantTestPlugin.ts',
      'src/chat-v2/debug/chatInteractionTestPlugin.ts',
      'src/chat-v2/debug/attachmentPipelineTestPlugin.ts',
      'src/chat-v2/debug/citationTestPlugin.ts',
      'src/chat-v2/debug/chatAnkiIntegrationTestPlugin.ts',
    ];

    for (const file of cleanupFiles) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');

      expect(source, file).toContain("'chat_v2_delete_session'");
      expect(source, file).not.toContain("'chat_v2_soft_delete_session'");
    }
  });

  it('does not keep obsolete chat page trash copy', () => {
    const localeFiles = [
      'src/locales/en-US/chatV2.json',
      'src/locales/zh-CN/chatV2.json',
    ];
    const obsoletePageKeys = [
      'trash',
      'trashEmpty',
      'trashTitle',
      'emptyTrash',
      'emptyTrashConfirmTitle',
      'emptyTrashConfirmDesc',
      'emptyTrashConfirm',
      'loadTrashFailed',
      'emptyTrashFailed',
      'restoreSession',
      'permanentDelete',
      'backToSessions',
    ];

    for (const file of localeFiles) {
      const locale = JSON.parse(readFileSync(resolve(process.cwd(), file), 'utf8'));

      for (const key of obsoletePageKeys) {
        expect(locale.page, `${file} page.${key}`).not.toHaveProperty(key);
      }
    }
  });
});

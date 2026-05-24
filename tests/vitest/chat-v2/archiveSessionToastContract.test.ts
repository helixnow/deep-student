import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('archive session toast contract', () => {
  it('announces archived sessions with the settings hint from every session archive path', () => {
    const modernSidebarSource = readFileSync(resolve(process.cwd(), 'src/components/ModernSidebar.tsx'), 'utf-8');
    const sessionEditSource = readFileSync(resolve(process.cwd(), 'src/chat-v2/pages/useSessionEdit.ts'), 'utf-8');
    const zhChatV2 = readFileSync(resolve(process.cwd(), 'src/locales/zh-CN/chatV2.json'), 'utf-8');
    const enChatV2 = readFileSync(resolve(process.cwd(), 'src/locales/en-US/chatV2.json'), 'utf-8');

    const toastHelperSource = readFileSync(resolve(process.cwd(), 'src/chat-v2/utils/archiveSessionToast.ts'), 'utf-8');

    expect(modernSidebarSource).toContain('showArchiveSessionToast');
    expect(sessionEditSource).toContain('showArchiveSessionToast');
    expect(toastHelperSource).toContain('showGlobalNotification');
    expect(toastHelperSource).toContain('archiveSessionToastMessage');
    expect(toastHelperSource).toContain('archiveSessionToastSettingsAction');
    expect(toastHelperSource).toContain('openArchivedSessionsSettings');
    expect(toastHelperSource).toContain("borderTone: 'neutral'");
    expect(zhChatV2).toContain('"archiveSessionToastMessage": "已归档。查看已归档的会话："');
    expect(zhChatV2).toContain('"archiveSessionToastSettingsAction": "设置"');
    expect(enChatV2).toContain('"archiveSessionToastMessage": "Archived. View archived sessions:"');
    expect(enChatV2).toContain('"archiveSessionToastSettingsAction": "Settings"');
  });
});

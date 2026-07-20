import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import zhChatV2 from '@/locales/zh-CN/chatV2.json';
import enChatV2 from '@/locales/en-US/chatV2.json';

function flattenLeafKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [prefix];
  }

  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flattenLeafKeys(child, prefix ? `${prefix}.${key}` : key)
  );
}

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

describe('ChatV2 i18n production contract', () => {
  it('keeps Chinese and English leaf-key sets aligned', () => {
    expect(flattenLeafKeys(zhChatV2).sort()).toEqual(flattenLeafKeys(enChatV2).sort());
  });

  it('owns the audited accessibility and export copy in chatV2 locales', () => {
    expect(zhChatV2.common.clearSearch).toBeTruthy();
    expect(enChatV2.common.clearSearch).toBeTruthy();
    expect(zhChatV2.askUser.send).toBeTruthy();
    expect(enChatV2.askUser.send).toBeTruthy();
    expect(zhChatV2.blocks.mcpTool.toolOutputImage).toBeTruthy();
    expect(enChatV2.blocks.mcpTool.toolOutputImage).toBeTruthy();
    expect(zhChatV2.browser.exportSuccess).toContain('{{messageCount}}');
    expect(enChatV2.browser.exportSuccess).toContain('{{messageCount}}');
    expect(zhChatV2.authority.modeSubtitles.plan).toBeTruthy();
    expect(enChatV2.authority.modeSubtitles.ask).toBeTruthy();
    expect(zhChatV2.inputBar.chip.pages_one).toContain('{{count}}');
    expect(enChatV2.inputBar.chip.pages_other).toContain('{{count}}');
  });

  it('does not hardcode audited composer and tool-output labels', () => {
    const plusMenu = readSource(
      'src/features/chat/components/input-bar/ComposerPlusMenu.tsx'
    );
    const composerPanel = readSource(
      'src/features/chat/components/input-bar/ComposerPanel/ComposerPanel.tsx'
    );
    const askUser = readSource('src/features/chat/plugins/blocks/askUserBlock.tsx');
    const toolOutput = readSource(
      'src/features/chat/plugins/blocks/components/ToolOutputView.tsx'
    );

    expect(plusMenu).not.toContain('>Plan</span>');
    expect(plusMenu).not.toContain('>Ask</span>');
    expect(composerPanel).not.toContain('aria-label="Clear search"');
    expect(askUser).not.toContain('aria-label="send"');
    expect(toolOutput).not.toContain('alt="Tool output"');
    expect(toolOutput).not.toContain('more rows');
  });

  it('uses locale interpolation for audited dynamic UI copy', () => {
    expect(zhChatV2.variant.retryFailedWithDetail).toContain('{{error}}');
    expect(enChatV2.variant.deleteFailedWithDetail).toContain('{{error}}');
    expect(zhChatV2.workspace.status.agentsCount).toContain('{{count}}');
    expect(enChatV2.blocks.ankiCards.progress.metrics.segmentsValue).toContain('{{total}}');

    const contextRefs = readSource('src/features/chat/context/vfsRefApi.ts');
    const variantActions = readSource('src/features/chat/core/store/variantActions.ts');
    const workspaceStatus = readSource('src/features/chat/plugins/blocks/workspaceStatus.tsx');

    expect(contextRefs).not.toContain("i18n.t('chatV2:context.resolve_failed_single'");
    expect(variantActions).not.toContain("i18n.t('chatV2:variant.retryFailed') +");
    expect(workspaceStatus).not.toContain("{t('workspace.status.agents')} (");
  });

  it('does not mask audited static translations with defaultValue text', () => {
    const sources = [
      'src/features/chat/plugins/chat/AdvancedPanel.tsx',
      'src/features/chat/core/session/createSessionWithDefaults.ts',
      'src/features/chat/plugins/blocks/components/ToolOutputView.tsx',
    ].map(readSource);

    for (const source of sources) {
      expect(source).not.toMatch(/defaultValue:\s*['"][^'"]+['"]/);
    }
  });

  it('passes the active application locale to audited date formatters', () => {
    const sources = [
      'src/features/chat/components/MessageItem.tsx',
      'src/features/chat/components/Variant/ParallelVariantView.tsx',
      'src/features/chat/components/message/messageItemUtils.ts',
      'src/features/chat/components/session-browser/SessionBrowser.tsx',
      'src/features/chat/debug/exportSessionDebug.ts',
      'src/features/chat/pages/useSessionEdit.ts',
      'src/features/chat/plugins/blocks/sleepBlock.tsx',
      'src/features/chat/plugins/blocks/subagentEmbed.tsx',
      'src/features/chat/plugins/blocks/subagentRetry.tsx',
      'src/features/chat/plugins/blocks/workspaceInjection.tsx',
      'src/features/chat/plugins/blocks/workspaceStatus.tsx',
      'src/features/chat/workspace/components/WorkspaceLogInline.tsx',
      'src/features/chat/workspace/components/WorkspaceMessageItem.tsx',
    ].map(readSource);

    for (const source of sources) {
      expect(source).not.toMatch(/toLocale(?:Date|Time)?String\(\s*(?:\)|undefined|\[\])/);
    }
  });
});

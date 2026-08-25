import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type ReuseCase = {
  source: string;
  keys: readonly string[];
  removedKeys: readonly string[];
};

const REUSE_CASES: readonly ReuseCase[] = [
  {
    source: 'src/components/ModernSidebar.tsx',
    keys: [
      'sidebar:navigation.hide_workbench_mode',
      'sidebar:navigation.show_workbench_mode',
    ],
    removedKeys: ['sidebar:actions.hide_workbench_mode', 'sidebar:actions.show_workbench_mode'],
  },
  {
    source: 'src/components/crepe/CrepeEditor.tsx',
    keys: [
      'notes:slashMenu.listGroup.taskList',
      'notes:slashMenu.advancedGroup.codeBlock',
      'notes:slashMenu.advancedGroup.callout',
      'notes:toggle.slashLabel',
    ],
    removedKeys: [
      'notes:blockMenu.taskList',
      'notes:blockMenu.codeBlock',
      'notes:blockMenu.callout',
      'notes:blockMenu.toggle',
    ],
  },
  {
    source: 'src/dstu/hooks/useDstuResource.ts',
    keys: ['dstu:resource.getResource'],
    removedKeys: ['common:loadResource'],
  },
  {
    source: 'src/features/learning-hub/apps/UnifiedAppPanel.tsx',
    keys: ['dstu:resource.getResource'],
    removedKeys: ['common:loadResource'],
  },
  {
    source: 'src/features/chat/components/InlineDocumentViewer.tsx',
    keys: [
      'chatV2:messageList.search.noResults',
      'chatV2:messageList.search.previous',
      'chatV2:messageList.search.next',
    ],
    removedKeys: [
      'chatV2:documentViewer.noMatches',
      'chatV2:documentViewer.prevMatch',
      'chatV2:documentViewer.nextMatch',
    ],
  },
  {
    source: 'src/features/chat/components/input-bar/AttachmentPanelBody.tsx',
    keys: ['common:more'],
    removedKeys: ['common:actions.more'],
  },
  {
    source: 'src/features/chat/plugins/chat/AdvancedPanel.tsx',
    keys: ['enhanced_rag:enable_reranking', 'chat_host:rag.panel.rerank_helper'],
    removedKeys: [
      'chatV2:ragPanel.multimodalRerankLabel',
      'chatV2:ragPanel.multimodalRerankHelper',
    ],
  },
  {
    source: 'src/features/chat/plugins/chat/RagPanel.tsx',
    keys: ['enhanced_rag:enable_reranking', 'chat_host:rag.panel.rerank_helper'],
    removedKeys: [
      'chatV2:ragPanel.multimodalRerankLabel',
      'chatV2:ragPanel.multimodalRerankHelper',
    ],
  },
  {
    source: 'src/features/notes/components/FindReplacePanel.tsx',
    keys: ['notes:findReplace.replaceMany'],
    removedKeys: ['notes:findReplace.replacedCount'],
  },
  {
    source: 'src/features/notes/components/NotesEditorHeader.tsx',
    keys: [
      'translation:stats.characters',
      'translation:stats.words',
      'notes:notifications.tagStateSaveFailed',
    ],
    removedKeys: [
      'notes:editor.stats.chars_label',
      'notes:editor.stats.words_label',
      'notes:header.tags_save_failed',
    ],
  },
  {
    source: 'src/features/settings/components/McpToolsSection.tsx',
    keys: ['common:expand'],
    removedKeys: ['settings:tool_permissions.expand_hint'],
  },
  {
    source: 'src/features/settings/components/VendorApiKeySection.tsx',
    keys: ['settings:vendor_panel.hide_api_key'],
    removedKeys: ['settings:vendor_panel.api_key_revealed_temporarily'],
  },
  {
    source: 'src/features/settings/components/WorkbenchSettingsSection.tsx',
    keys: ['workbench:wallpaperManager.limitReached'],
    removedKeys: ['workbench:settings.wallpaper.limitReached'],
  },
];

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

function readLocale(language: 'en-US' | 'zh-CN', namespace: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), `src/locales/${language}/${namespace}.json`), 'utf8'),
  ) as Record<string, unknown>;
}

function readPath(value: Record<string, unknown>, keyPath: string): unknown {
  return keyPath.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

describe('v0.9.44 release-upgrade i18n regressions', () => {
  it('reuses keys that exist in both supported locales', () => {
    for (const { source, keys } of REUSE_CASES) {
      const sourceText = readSource(source);
      for (const namespacedKey of keys) {
        const separatorIndex = namespacedKey.indexOf(':');
        const namespace = namespacedKey.slice(0, separatorIndex);
        const keyPath = namespacedKey.slice(separatorIndex + 1);
        expect(sourceText, `${source} must use ${namespacedKey}`).toContain(namespacedKey);
        for (const language of ['en-US', 'zh-CN'] as const) {
          const value = readPath(readLocale(language, namespace), keyPath);
          expect(value, `${language} must define ${namespacedKey}`).toEqual(expect.any(String));
          expect((value as string).trim()).not.toBe('');
        }
      }
    }
  });

  it('does not restore the audited missing key paths', () => {
    for (const { source, removedKeys } of REUSE_CASES) {
      const sourceText = readSource(source);
      for (const removedKey of removedKeys) {
        expect(sourceText, `${source} must not use missing key ${removedKey}`).not.toContain(removedKey);
      }
    }
  });

  it('keeps explicit fallbacks for locale-specific mind-map plural shapes', () => {
    const versionSource = readSource(
      'src/features/mindmap/components/toolbar/VersionHistoryPanel.tsx',
    );
    const importerSource = readSource('src/features/mindmap/utils/importers.ts');

    expect(versionSource).toMatch(
      /mindmap:shellV2\.versions\.nodeCount[\s\S]*?defaultValue:\s*['"]\{\{count\}\} node\(s\)['"]/,
    );
    expect(importerSource).toMatch(
      /mindmap:import\.imagePlaceholderNote[\s\S]*?defaultValue:/,
    );

    const en = readLocale('en-US', 'mindmap');
    const zh = readLocale('zh-CN', 'mindmap');
    expect(readPath(en, 'shellV2.versions.nodeCount_one')).toEqual(expect.any(String));
    expect(readPath(en, 'shellV2.versions.nodeCount_other')).toEqual(expect.any(String));
    expect(readPath(zh, 'shellV2.versions.nodeCount')).toEqual(expect.any(String));
    expect(readPath(en, 'import.imagePlaceholderNote_one')).toEqual(expect.any(String));
    expect(readPath(en, 'import.imagePlaceholderNote_other')).toEqual(expect.any(String));
    expect(readPath(zh, 'import.imagePlaceholderNote')).toEqual(expect.any(String));
  });
});

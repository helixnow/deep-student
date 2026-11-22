import React, { createRef } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { computed, effectScope } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrepeEditorApi } from '../types';
import { doc, p, textPos } from './blockCommandFixtures';
import { EditorState, TextSelection } from '@milkdown/prose/state';
import { EditorView as ProseView } from '@milkdown/prose/view';

const recorded = vi.hoisted(() => ({
  instances: [] as Array<{ options: Record<string, any> }>,
}));

vi.mock('@milkdown/crepe', () => ({
  CrepeFeature: new Proxy({}, { get: (_, key) => key }),
  Crepe: class {
    view!: ProseView;
    ctx = { get: () => this.view, update: () => {} };
    editor = {
      ctx: this.ctx,
      action: (fn: (ctx: unknown) => unknown) => fn(this.ctx),
      config: (fn: (ctx: unknown) => void) => { fn(this.ctx); return this.editor; },
      use: () => this.editor,
    };
    constructor(private options: { root: HTMLElement } & Record<string, any>) {
      recorded.instances.push({ options });
    }
    async create() {
      const content = doc(p('target'));
      this.view = new ProseView(this.options.root, {
        state: EditorState.create({
          doc: content,
          selection: TextSelection.create(content, textPos(content, 'target'), textPos(content, 'target') + 'target'.length),
        }),
        dispatchTransaction: (tr) => this.view.updateState(this.view.state.apply(tr)),
      });
    }
    getMarkdown() { return this.view.state.doc.textContent; }
    setReadonly() {}
    async destroy() { if (this.view && !this.view.isDestroyed) this.view.destroy(); }
  },
}));
vi.mock('../commandRegistry', async (load) => ({ ...(await load<object>()) }));
vi.mock('../features/imageUpload', () => ({
  createImageBlockConfig: () => ({}), createImageUploader: () => vi.fn(),
  createTransientBlobUrlRegistry: () => ({ register: vi.fn(), releaseAll: vi.fn() }),
  pickImageWithTauriDialog: vi.fn(), readLocalImageFile: vi.fn(), validateImageFile: vi.fn(),
}));
vi.mock('../features/mermaidPreview', () => ({ createMermaidObserver: vi.fn() }));
vi.mock('../useCrepeEditor', () => ({ createAgentInsertTransaction: vi.fn() }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/shared/debug/channels/crepeEditor', () => ({ emitCrepeDebug: vi.fn(), captureDOMSnapshot: vi.fn() }));
vi.mock('@/shared/debug/channels/crepeImageUpload', () => ({
  emitImageUploadDebug: vi.fn(), captureDOMInfo: vi.fn(), captureImageBlockSnapshot: vi.fn(),
}));
vi.mock('@/debug-panel/events/NotesOutlineDebugChannel', () => ({
  emitOutlineDebugLog: vi.fn(), emitOutlineDebugSnapshot: vi.fn(),
}));
vi.mock('@/debug-panel/debugMasterSwitch', () => ({
  debugMasterSwitch: { isEnabled: () => false },
  debugLog: { log: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import i18n from '@/i18n';
import { UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import { defineUiPlugin } from '@/ui-sdk';
import { installOfficialUiPlugins } from '@/ui-plugins/official/install';
import { memoryRegistryAdapters } from '@/ui-plugins/testing/registries';
import { CrepeEditor } from '../CrepeEditor';

class FakeGroupBuilder {
  private groups: Array<{ key: string; label: string; items: string[] }> = [];
  addGroup(key: string, label: string) {
    const existing = this.groups.find(g => g.key === key);
    const group = existing ?? { key, label, items: [] };
    if (!existing) this.groups.push(group);
    return {
      addItem: (itemKey: string) => {
        group.items.push(itemKey);
        return this.instance(group);
      },
    };
  }
  private instance(group: { key: string; label: string; items: string[] }) {
    return {
      addItem: (itemKey: string) => {
        group.items.push(itemKey);
        return this.instance(group);
      },
    };
  }
  getGroup(groupKey: string) {
    return this.groups.find(g => g.key === groupKey) ?? null;
  }
  build() {
    return this.groups;
  }
  clear() {
    this.groups = [];
    return this;
  }
  getItemKeys(groupKey: string) {
    return this.groups.find(g => g.key === groupKey)?.items ?? [];
  }
}

describe('CrepeEditor editor.selectionToolbar live refresh (BUG-04)', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(500);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(300);
  });

  afterEach(() => {
    cleanup();
    recorded.instances = [];
    vi.restoreAllMocks();
  });

  it('re-evaluates buildToolbar reactively when community plugins install or unload while preserving config keys', async () => {
    for (let i = 0; i < 200 && !i18n.hasResourceBundle('zh-CN', 'notes'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const kernel = new UiKernel(memoryRegistryAdapters());
    await installOfficialUiPlugins(kernel);

    const ready = vi.fn();
    const ref = createRef<CrepeEditorApi>();
    render(
      <UiKernelProvider kernel={kernel}>
        <CrepeEditor ref={ref} noteId="note-live" onReady={ready} />
      </UiKernelProvider>,
    );
    await waitFor(() => expect(ready).toHaveBeenCalledTimes(1));

    const toolbarConfig = recorded.instances[0]!.options.featureConfigs.Toolbar;
    expect(Object.keys(toolbarConfig)).toEqual(['buildToolbar']);

    const scope = effectScope();
    try {
      const customItems = scope.run(() => computed(() => {
        const builder = new FakeGroupBuilder();
        toolbarConfig.buildToolbar(builder);
        return builder.getItemKeys('community.live:custom');
      }))!;

      expect(customItems.value).not.toContain('community.live:mnemonic');

      const plugin = defineUiPlugin({
        meta: { id: 'community.live', version: '1.0.0' },
        apply(ctx) {
          ctx.ui.contribute('editor.selectionToolbar', {
            id: 'mnemonic',
            value: {
              build(toolbar) {
                toolbar.addGroup('custom', 'Custom').addItem('mnemonic', {
                  label: 'Mnemonic',
                  icon: '<svg viewBox="0 0 16 16"></svg>',
                  onRun: () => {},
                });
              },
            },
          });
        },
      });

      await act(async () => {
        await kernel.install(plugin, { origin: 'community' });
      });

      await waitFor(() => {
        expect(customItems.value).toContain('community.live:mnemonic');
      });

      await act(async () => {
        await kernel.unload('community.live');
      });

      await waitFor(() => {
        expect(customItems.value).not.toContain('community.live:mnemonic');
      });
    } finally {
      scope.stop();
      await kernel.dispose();
    }
  });
});

/**
 * ProseMirror handlePaste：纯文本单个 URL 时接管，优先于 @milkdown/plugin-clipboard。
 *
 * 注册侧请 `crepe.editor.use(pasteLinkPlugin())`（见 docs/revamp/05-paste-link.md）。
 * 本模块将插件 prepend 进 prosePluginsCtx，确保 someProp(handlePaste) 先于 clipboard。
 */

import type { MilkdownPlugin } from '@milkdown/ctx';
import { SchemaReady, prosePluginsCtx } from '@milkdown/core';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';

import { applyPasteUrlLink, shouldSkipPasteLinkContext } from './applyPasteUrlLink';
import { isSinglePasteUrl } from './isSinglePasteUrl';

export const pasteLinkKey = new PluginKey('crepePasteLink');

function hasClipboardFiles(data: DataTransfer | null): boolean {
  if (!data) return false;
  if (data.files && data.files.length > 0) return true;
  const types = Array.from(data.types ?? []);
  return types.some((t) => t === 'Files' || t === 'application/x-moz-file');
}

/**
 * handlePaste 核心：可单测。返回 true 表示已接管。
 */
export function handlePasteUrl(
  view: EditorView,
  event: ClipboardEvent,
): boolean {
  const editable = view.props.editable?.(view.state);
  if (editable === false) return false;

  const { clipboardData } = event;
  if (!clipboardData) return false;
  if (hasClipboardFiles(clipboardData)) return false;

  // VS Code 带语言的粘贴交给 clipboard 插件建代码块
  if (clipboardData.getData('vscode-editor-data')) return false;

  if (shouldSkipPasteLinkContext(view.state)) return false;

  const plain = clipboardData.getData('text/plain') ?? '';
  const url = isSinglePasteUrl(plain);
  if (!url) return false;

  const tr = applyPasteUrlLink(view.state, url);
  if (!tr) return false;

  view.dispatch(tr);
  return true;
}

function createPasteLinkPmPlugin(): Plugin {
  return new Plugin({
    key: pasteLinkKey,
    props: {
      handlePaste(view, event) {
        return handlePasteUrl(view, event as ClipboardEvent);
      },
    },
  });
}

/**
 * Milkdown 统一入口。不自行挂到 Crepe；由接线方 `editor.use(pasteLinkPlugin())`。
 *
 * 实现上 prepend 到 prosePluginsCtx：ProseMirror `someProp` 按插件数组正序取第一个
 * 返回真值的 handlePaste，须排在 `@milkdown/plugin-clipboard`（$prose append）之前。
 */
export function pasteLinkPlugin(): MilkdownPlugin {
  const plugin: MilkdownPlugin = (ctx) => async () => {
    await ctx.wait(SchemaReady);
    const pmPlugin = createPasteLinkPmPlugin();
    ctx.update(prosePluginsCtx, (ps) => [pmPlugin, ...ps]);

    return () => {
      ctx.update(prosePluginsCtx, (ps) => ps.filter((x) => x !== pmPlugin));
    };
  };
  return plugin;
}

/** 仅供测试：构造裸 ProseMirror Plugin（不含 Milkdown 注册）。 */
export function createPasteLinkProsePluginForTest(): Plugin {
  return createPasteLinkPmPlugin();
}

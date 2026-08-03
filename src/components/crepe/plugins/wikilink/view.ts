/**
 * wikilink NodeView：解析态样式 + 点击跳转/创建
 * 只读模式下仍可点击；不可编辑（atom + contenteditable=false）。
 *
 * - 歧义标题（resolve.ambiguous）：着重样式 + 点击弹出锚定候选浮层（B13）
 * - 已解析链接：悬停显示目标笔记内容预览卡片
 */

import i18next from 'i18next';
import type { Node as ProseNode } from '@milkdown/prose/model';
import type { EditorView, NodeView } from '@milkdown/prose/view';
import { $view } from '@milkdown/utils';

import { wikilinkSchema, WIKILINK_NODE_NAME } from './schema';
import { splitWikiLinkTarget } from './format';
import {
  closeWikilinkCandidatePickerFor,
  openWikilinkCandidatePicker,
} from './candidatePicker';
import {
  closeWikilinkCreateConfirm,
  closeWikilinkCreateConfirmFor,
  isWikilinkCreateConfirmOpenFor,
  openWikilinkCreateConfirm,
} from './createConfirm';
import {
  cancelWikilinkPreview,
  hideWikilinkPreviewNow,
  scheduleWikilinkPreview,
} from './hoverPreview';
import {
  dispatchCreateFromWikilink,
  dispatchOpenNote,
  normalizeResolve,
  type WikilinkPluginConfig,
} from './types';

function displayText(node: ProseNode): string {
  const label = (node.attrs.label as string) || '';
  const target = (node.attrs.target as string) || '';
  return label || target || '';
}

/** '/folder/sub/note_1' → '/folder/sub'；根目录或缺失时返回 '' */
function folderFromPath(path: string | undefined): string {
  if (!path) return '';
  const cut = path.lastIndexOf('/');
  return cut > 0 ? path.slice(0, cut) : '';
}

/**
 * 预览卡 meta（所在文件夹路径）。宿主缓存的 getNotes 同步返回数组；
 * 异步数据源直接跳过（meta 非关键信息，不值得等待）。
 */
function previewMetaFor(
  getNotes: WikilinkPluginConfig['getNotes'],
  noteId: string,
): string | undefined {
  if (!getNotes) return undefined;
  try {
    const notes = getNotes();
    if (!Array.isArray(notes)) return undefined;
    const note = (notes as readonly { id: string; path?: string }[]).find((n) => n.id === noteId);
    return folderFromPath(note?.path) || undefined;
  } catch {
    return undefined;
  }
}

function createWikilinkView(
  config: WikilinkPluginConfig,
): (node: ProseNode, view: EditorView, getPos: () => number | undefined) => NodeView {
  const resolve = config.resolve;
  return (initialNode) => {
    let node = initialNode;
    const dom = document.createElement('span');
    dom.setAttribute('data-type', WIKILINK_NODE_NAME);
    dom.setAttribute('contenteditable', 'false');
    dom.setAttribute('spellcheck', 'false');
    dom.classList.add('crepe-wikilink');

    const apply = (n: ProseNode) => {
      const target = (n.attrs.target as string) || '';
      const label = (n.attrs.label as string) || '';
      const { noteTarget, heading } = splitWikiLinkTarget(target);
      const resolution = normalizeResolve(resolve, noteTarget);
      const ambiguous = Boolean(resolution.ambiguous);
      dom.setAttribute('data-target', target);
      dom.setAttribute('data-label', label);
      if (heading) dom.setAttribute('data-heading', heading);
      else dom.removeAttribute('data-heading');
      dom.setAttribute('data-resolved', resolution.resolved ? 'true' : 'false');
      dom.classList.toggle('crepe-wikilink--unresolved', !resolution.resolved);
      dom.classList.toggle('crepe-wikilink--ambiguous', ambiguous);
      if (ambiguous) dom.setAttribute('data-ambiguous', 'true');
      else dom.removeAttribute('data-ambiguous');
      dom.textContent = displayText(n);
      dom.title = ambiguous
        ? i18next.t('notes:wikilink.ambiguousTitle', {
          defaultValue: '「{{target}}」命中 {{count}} 篇同名笔记，点击选择',
          target: noteTarget,
          count: resolution.candidateIds?.length ?? 0,
        })
        : target;
    };

    apply(node);

    const onClick = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      hideWikilinkPreviewNow();
      const target = (node.attrs.target as string) || '';
      if (!target) return;
      const { noteTarget, heading } = splitWikiLinkTarget(target);
      if (!noteTarget) return;
      const resolution = normalizeResolve(resolve, noteTarget);
      if (!resolution.resolved) {
        // 内联确认气泡：误触不再静默建出空笔记；再次点击同一链接则收起
        if (isWikilinkCreateConfirmOpenFor(dom)) {
          closeWikilinkCreateConfirm();
          return;
        }
        openWikilinkCreateConfirm({
          anchor: dom,
          title: noteTarget,
          onConfirm: () => dispatchCreateFromWikilink(noteTarget),
        });
        return;
      }
      const candidateIds = resolution.candidateIds ?? [];
      if (resolution.ambiguous && candidateIds.length > 1) {
        openWikilinkCandidatePicker({
          anchor: dom,
          target: noteTarget,
          heading,
          candidateIds,
          getNotes: config.getNotes,
        });
        return;
      }
      dispatchOpenNote(noteTarget, resolution.noteId || noteTarget, heading);
    };

    const onIndexUpdated = (event: Event) => {
      const changedTarget = (event as CustomEvent<{ target?: string }>).detail?.target?.trim();
      const nodeTarget = splitWikiLinkTarget((node.attrs.target as string) || '').noteTarget;
      if (!changedTarget || changedTarget === nodeTarget) apply(node);
    };

    const onMouseEnter = () => {
      const target = (node.attrs.target as string) || '';
      const { noteTarget } = splitWikiLinkTarget(target);
      if (!noteTarget) return;
      const resolution = normalizeResolve(resolve, noteTarget);
      // 歧义链接不预览（无法确定目标）；未解析链接无内容可预览
      if (!resolution.resolved || resolution.ambiguous || !resolution.noteId) return;
      scheduleWikilinkPreview(dom, resolution.noteId, displayText(node) || noteTarget, {
        meta: previewMetaFor(config.getNotes, resolution.noteId),
      });
    };

    const onMouseLeave = () => {
      cancelWikilinkPreview(dom);
    };

    const onMouseDown = (event: MouseEvent) => {
      // 避免只读/编辑态下 mousedown 抢焦点导致选区跳动
      if (event.button === 0) event.preventDefault();
    };

    dom.addEventListener('click', onClick);
    dom.addEventListener('mouseenter', onMouseEnter);
    dom.addEventListener('mouseleave', onMouseLeave);
    dom.addEventListener('mousedown', onMouseDown);
    window.addEventListener('notes:wikilink-index-updated', onIndexUpdated);

    return {
      dom,
      update(updated) {
        if (updated.type.name !== WIKILINK_NODE_NAME) return false;
        node = updated;
        apply(node);
        return true;
      },
      selectNode() {
        dom.classList.add('crepe-wikilink--selected');
      },
      deselectNode() {
        dom.classList.remove('crepe-wikilink--selected');
      },
      stopEvent: () => true,
      ignoreMutation: () => true,
      destroy() {
        dom.removeEventListener('click', onClick);
        dom.removeEventListener('mouseenter', onMouseEnter);
        dom.removeEventListener('mouseleave', onMouseLeave);
        dom.removeEventListener('mousedown', onMouseDown);
        window.removeEventListener('notes:wikilink-index-updated', onIndexUpdated);
        cancelWikilinkPreview(dom);
        // 只关自己锚定的浮层，别的实例（其它链接/编辑器）的浮层不受影响
        closeWikilinkCandidatePickerFor(dom);
        closeWikilinkCreateConfirmFor(dom);
      },
    };
  };
}

export function createWikilinkViewPlugin(config: WikilinkPluginConfig = {}) {
  return $view(wikilinkSchema.node, () => createWikilinkView(config));
}

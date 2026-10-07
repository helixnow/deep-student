/**
 * Crepe 媒体时间戳回链插件（`[媒体@id:mm:ss]` 文本标记 + `mediaref://` 链接）
 *
 * 只做装饰 + click 拦截 + 事件派发；打开/跳转复用 media-ref:open → media-ref:focus。
 *   crepe.editor.use(mediaRefPlugin()); // 需在 crepe.create() 之前
 */

import { Plugin, PluginKey } from '@milkdown/prose/state';
import type { Node as ProseNode } from '@milkdown/prose/model';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { $prose } from '@milkdown/utils';
import i18next from 'i18next';

import { formatMediaRefTimestamp } from '@/features/learning-hub/apps/views/media/mediaRefTime';
import { handleMediaRefClick, MEDIA_REF_ANCHOR_ATTR, MEDIA_REF_SECONDS_ATTR } from './click';
import { findMediaRefMarkers } from './protocol';
import './mediaRef.css';

export {
  MEDIA_REF_HREF_PROTOCOL,
  buildMediaRefHref,
  parseMediaRefHref,
  findMediaRefMarkers,
  type MediaRefTarget,
} from './protocol';
export { handleMediaRefClick } from './click';

export const mediaRefKey = new PluginKey<DecorationSet>('crepeMediaRef');

/** 扫描文档中的 `[媒体@…]` 标记生成 inline 装饰（代码块内不处理） */
/** 徽章上显示的文字（不含资源 id）；完整标记只在光标进入时露出供编辑 */
export const MEDIA_REF_LABEL_ATTR = 'data-media-ref-label';

/**
 * @param editing 光标 / 选区所在区间：与之相交的标记显示原文（可编辑），其余收成「▶ 00:05」徽章，
 *   不再把 `[媒体@file_xxx:00:05]` 原样露给读者。
 */
export function buildMediaRefDecorations(
  doc: ProseNode,
  editing?: { from: number; to: number },
): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos, parent) => {
    if (node.type.spec.code) return false;
    if (!node.isText || !node.text) return true;
    if (parent?.type.spec.code) return false;
    for (const m of findMediaRefMarkers(node.text)) {
      const time = formatMediaRefTimestamp(m.seconds);
      const from = pos + m.from;
      const to = pos + m.to;
      const isEditing = !!editing && editing.from <= to && editing.to >= from;
      const title = i18next.t('learningHub:mediaTranscript.seekTo', {
        time,
        defaultValue: `▶ ${time}`,
      });
      const anchorAttrs = {
        [MEDIA_REF_ANCHOR_ATTR]: m.resourceId,
        [MEDIA_REF_SECONDS_ATTR]: String(m.seconds),
        title,
      };
      if (isEditing) {
        decorations.push(Decoration.inline(from, to, { class: 'crepe-media-ref', ...anchorAttrs }));
        continue;
      }
      // 原文隐藏（仍在文档里，光标进入时切回原文），前面插一个「▶ mm:ss」徽章 widget
      decorations.push(
        Decoration.inline(from, to, { class: 'crepe-media-ref-raw', [MEDIA_REF_LABEL_ATTR]: `▶ ${time}` }),
      );
      decorations.push(
        Decoration.widget(
          from,
          () => {
            const badge = document.createElement('span');
            badge.className = 'crepe-media-ref crepe-media-ref--badge';
            badge.textContent = `▶ ${time}`;
            badge.setAttribute(MEDIA_REF_ANCHOR_ATTR, m.resourceId);
            badge.setAttribute(MEDIA_REF_SECONDS_ATTR, String(m.seconds));
            badge.setAttribute('title', title);
            badge.setAttribute('contenteditable', 'false');
            return badge;
          },
          { side: -1, key: `media-ref:${m.resourceId}:${m.seconds}:${from}`, ignoreSelection: true },
        ),
      );
    }
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

export function mediaRefPlugin() {
  return $prose(
    () =>
      new Plugin<DecorationSet>({
        key: mediaRefKey,
        state: {
          init: (_config, state) => buildMediaRefDecorations(state.doc, state.selection),
          apply: (tr, old, _oldState, newState) =>
            tr.docChanged || tr.selectionSet
              ? buildMediaRefDecorations(newState.doc, newState.selection)
              : old,
        },
        props: {
          decorations(state) {
            return mediaRefKey.getState(state);
          },
          handleDOMEvents: {
            click(view, event) {
              return handleMediaRefClick(view, event);
            },
          },
        },
      }),
  );
}

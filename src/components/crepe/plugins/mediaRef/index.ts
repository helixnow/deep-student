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
export function buildMediaRefDecorations(doc: ProseNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos, parent) => {
    if (node.type.spec.code) return false;
    if (!node.isText || !node.text) return true;
    if (parent?.type.spec.code) return false;
    for (const m of findMediaRefMarkers(node.text)) {
      const time = formatMediaRefTimestamp(m.seconds);
      decorations.push(
        Decoration.inline(pos + m.from, pos + m.to, {
          class: 'crepe-media-ref',
          [MEDIA_REF_ANCHOR_ATTR]: m.resourceId,
          [MEDIA_REF_SECONDS_ATTR]: String(m.seconds),
          title: i18next.t('learningHub:mediaTranscript.seekTo', {
            time,
            defaultValue: `▶ ${time}`,
          }),
        }),
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
          init: (_config, state) => buildMediaRefDecorations(state.doc),
          apply: (tr, old) => (tr.docChanged ? buildMediaRefDecorations(tr.doc) : old),
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

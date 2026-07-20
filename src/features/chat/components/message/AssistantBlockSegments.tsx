/**
 * AssistantBlockSegments - 助手消息块的分段渲染
 *
 * 从 MessageItem 的 JSX 内联 IIFE 抽出：
 * - 分段逻辑走纯函数 buildAssistantSegments（messageItemUtils.ts）
 * - 时间线段 → ActivityTimelineWithStore（分组渲染，内部独立订阅）
 * - 内容段 → BlockRendererWithStore（按 blockId 独立订阅）
 */

import React, { useMemo } from 'react';
import type { StoreApi } from 'zustand';
import { BlockRendererWithStore } from '../BlockRenderer';
import { ActivityTimelineWithStore } from '../ActivityTimeline';
import type { Block, ChatStore } from '../../core/types';
import { buildAssistantSegments } from './messageItemUtils';

export interface AssistantBlockSegmentsProps {
  /** Store 实例 */
  store: StoreApi<ChatStore>;
  /** 当前显示的块（已按显示顺序排列） */
  blocks: Block[];
  /** 继续执行回调（工具限制节点使用） */
  onContinue?: () => Promise<void>;
  /** 打开笔记回调（笔记工具预览点击时触发） */
  onOpenNote?: (noteId: string) => void;
}

export const AssistantBlockSegments: React.FC<AssistantBlockSegmentsProps> = ({
  store,
  blocks,
  onContinue,
  onOpenNote,
}) => {
  const segments = useMemo(() => buildAssistantSegments(blocks), [blocks]);

  return (
    <>
      {segments.map((segment) => {
        if (segment.type === 'timeline') {
          return (
            <React.Fragment key={segment.key}>
              <ActivityTimelineWithStore
                store={store}
                blockIds={segment.blockIds}
                onContinue={onContinue}
                onOpenNote={onOpenNote}
              />
              {/* 流式空 content 块（正常显示），BlockRenderer 内部订阅 chunk 更新 */}
              {segment.streamingEmptyBlockIds?.map((blockId) => (
                <BlockRendererWithStore key={blockId} store={store} blockId={blockId} />
              ))}
            </React.Fragment>
          );
        }
        return segment.blockIds.map((blockId) => (
          <BlockRendererWithStore key={blockId} store={store} blockId={blockId} />
        ));
      })}
    </>
  );
};

export default AssistantBlockSegments;

/**
 * ChatSessionWindowFrame — chat-session 窗口的先导轻壳
 *
 * 与 ChatWindowFrame 同款 O16 模式：register 的 render 懒加载指向本模块
 * （小 chunk：仅 React + 骨架屏），重代码（ChatSessionSurface → ChatContainer
 * 全家桶）由内层 React.lazy 二段加载，期间显示消息气泡骨架。
 *
 * 注意：本文件不得 import 任何 chat 核心模块。
 */
import React, { Suspense } from 'react';
import type { AppWindowProps } from '../../core/types';
import { ChatWindowSkeleton } from './ChatWindowSkeleton';

const ChatSessionWindowLazy = React.lazy(() => import('./ChatSessionWindow'));

export const ChatSessionWindowFrame: React.FC<AppWindowProps> = (props) => (
  <Suspense fallback={<ChatWindowSkeleton />}>
    <ChatSessionWindowLazy {...props} />
  </Suspense>
);

export default ChatSessionWindowFrame;

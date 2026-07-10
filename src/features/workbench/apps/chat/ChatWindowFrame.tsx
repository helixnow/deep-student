/**
 * ChatWindowFrame — chat 窗口的先导轻壳（O16）
 *
 * register.ts 的 render 懒加载指向本模块（小 chunk：仅 React + 骨架屏），
 * 真正的重代码（ChatAppWindow → ChatSessionSurface → ChatContainer 全家桶）
 * 由本壳内层的 React.lazy 二段加载，加载期间用消息气泡骨架屏占位——
 * 替代 WindowBody 通用 Suspense 转圈，消灭开 chat 窗时的空白/转圈观感。
 *
 * 注意：本文件不得 import 任何 chat 核心模块（会把重代码拽回先导 chunk）。
 */
import React, { Suspense } from 'react';
import type { AppWindowProps } from '../../core/types';
import { ChatWindowSkeleton } from './ChatWindowSkeleton';

const ChatAppWindowLazy = React.lazy(() => import('./ChatAppWindow'));

export const ChatWindowFrame: React.FC<AppWindowProps> = (props) => (
  <Suspense fallback={<ChatWindowSkeleton />}>
    <ChatAppWindowLazy {...props} />
  </Suspense>
);

export default ChatWindowFrame;

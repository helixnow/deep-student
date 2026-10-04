/**
 * Learning Hub 打开意图握手 —— 跨页「在学习资源中打开 X」与 LearningHubPage 挂载时序解耦。
 *
 * 旧方案：App 先 setCurrentView('learning-hub')，再隔一帧 / 150ms 派发
 * learningHubOpen* 事件，赌 LearningHubPage 届时已挂载。但这些事件的监听者在
 * lazy LearningHubPage 的 useEffect 里注册：首次进入（chunk 尚在加载）、或触屏
 * 设备被视图 LRU 淘汰（MAX_ALIVE_VIEWS_TOUCH）后重进时，事件早到即丢，用户只看到
 * 学习资源页却没打开目标。
 *
 * 新方案（与 chat 的 pendingChatNavigation 同构）：
 * - 页面已就绪（监听器已注册）时，请求立即派发为标准事件；
 * - 未就绪时挂起意图（只保留最新一条，带时效），不派发；
 * - LearningHubPage 注册完监听器后调用 markLearningHubReady()，重放挂起意图；
 *   卸载时解除就绪。
 *
 * 本模块保持零运行时依赖（仅 type import）。
 */

import type { AppEventPayloads } from '@/events/app';

export type LearningHubIntentType =
  | 'learningHubOpenExam'
  | 'learningHubOpenTranslation'
  | 'learningHubOpenEssay'
  | 'learningHubOpenNote'
  | 'learningHubOpenResource'
  | 'learningHubNavigateToKnowledge';

export interface PendingLearningHubIntent<K extends LearningHubIntentType = LearningHubIntentType> {
  type: K;
  detail: AppEventPayloads[K];
  requestedAt: number;
}

/**
 * 挂起意图的有效期：覆盖 lazy chunk 冷加载（移动端可达数秒），
 * 又避免用户早已离开后，下次进入学习资源页时被陈旧意图「拽」去打开旧资源。
 */
export const PENDING_LEARNING_HUB_INTENT_TTL_MS = 15_000;

let pending: PendingLearningHubIntent | null = null;
let readyCount = 0;

function dispatchIntent(type: LearningHubIntentType, detail: unknown): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(type, { detail }));
}

/** LearningHubPage 是否已挂载且监听器已注册。 */
export function isLearningHubReady(): boolean {
  return readyCount > 0;
}

/**
 * 请求在学习资源页执行一次打开/导航。
 * 已就绪 → 立即派发；未就绪 → 挂起（后写覆盖），待 markLearningHubReady() 重放。
 * 调用方负责切换到 learning-hub 视图（触发挂载）。
 */
export function requestLearningHubIntent<K extends LearningHubIntentType>(
  type: K,
  detail: AppEventPayloads[K],
): void {
  if (isLearningHubReady()) {
    pending = null;
    dispatchIntent(type, detail);
    return;
  }
  pending = { type, detail, requestedAt: Date.now() } as PendingLearningHubIntent;
}

/** 作废挂起意图。 */
export function invalidatePendingLearningHubIntent(): void {
  pending = null;
}

/**
 * LearningHubPage 注册完事件监听器后调用：进入就绪态并重放未过期的挂起意图。
 * 返回解除函数（页面卸载时调用），幂等。
 */
export function markLearningHubReady(): () => void {
  readyCount += 1;
  const intent = pending;
  pending = null;
  if (intent && Date.now() - intent.requestedAt <= PENDING_LEARNING_HUB_INTENT_TTL_MS) {
    dispatchIntent(intent.type, intent.detail);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    readyCount = Math.max(0, readyCount - 1);
  };
}

/** 测试辅助：查看当前挂起意图。 */
export function peekPendingLearningHubIntent(): PendingLearningHubIntent | null {
  return pending;
}

/** 测试辅助：重置模块状态。 */
export function resetLearningHubIntentHandshakeForTest(): void {
  pending = null;
  readyCount = 0;
}

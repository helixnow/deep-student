/**
 * 会话内容列宽度比例配置
 *
 * 宽度契约单一来源：src/styles/shadcn-variables.css `--chat-thread-max-w`，
 * 取值为 `max(44rem, calc(1% * var(--chat-thread-ratio)))`——
 * 内容列先锁 44rem 阅读宽，父级可用宽超过 44rem÷比例 后按占比继续延展，
 * 切换点处两值相等，过渡连续无跳变；窄屏 44rem 上限 + width:100% 兜底，不溢出。
 *
 * 所有消费方（ThreadContentShell / max-w-thread / --chat-content-max-width /
 * workbench 骨架）均读 --chat-thread-max-w，因此调节只需在 <html> 上内联覆写
 * 数字变量 --chat-thread-ratio（默认 80，即 80%），全链路自动跟随。
 */

export const CHAT_THREAD_WIDTH_RATIO_STORAGE_KEY = 'chat.threadWidthRatio';

export const DEFAULT_CHAT_THREAD_WIDTH_RATIO = 80;
export const MIN_CHAT_THREAD_WIDTH_RATIO = 50;
export const MAX_CHAT_THREAD_WIDTH_RATIO = 100;

export const clampThreadWidthRatio = (value: number): number => {
  if (!Number.isFinite(value)) return DEFAULT_CHAT_THREAD_WIDTH_RATIO;
  return Math.min(MAX_CHAT_THREAD_WIDTH_RATIO, Math.max(MIN_CHAT_THREAD_WIDTH_RATIO, Math.round(value)));
};

export const normalizeThreadWidthRatio = (raw: string | null | undefined): number =>
  clampThreadWidthRatio(parseFloat(String(raw ?? '')));

/**
 * 应用宽度比例到 CSS 变量（内联数字变量优先级高于 :root 规则；
 * --chat-thread-max-w 与 chat-beautify.css 的对齐规则都经 calc 引用它）
 */
export const applyThreadWidthRatioToDocument = (ratio: number): void => {
  document.documentElement.style.setProperty('--chat-thread-ratio', String(clampThreadWidthRatio(ratio)));
};

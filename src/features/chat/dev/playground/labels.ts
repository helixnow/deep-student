import type { StreamingSmoothingPreset } from '../../components/renderers/streamingSmoothing';
import type { StreamRenderingMode } from '../../components/renderers/StreamingMarkdownRenderer';

const STREAMING_PRESET_LABELS: Record<StreamingSmoothingPreset, string> = {
  natural: '自然',
  realtime: '实时',
  balanced: '均衡',
  silky: '丝滑',
  fluid: '流畅',
};

const STREAMING_PRESET_HINTS: Record<StreamingSmoothingPreset, string> = {
  natural: '原生速度，尽量贴近模型真实吐字节奏。',
  realtime: '强调即时反馈，适合观察最敏捷的流式体验。',
  balanced: '速度与稳定性折中，适合作为默认观察档位。',
  silky: '更偏顺滑连贯，减少视觉抖动和跳变。',
  fluid: '偏持续流动感，适合长文本连续阅读对比。',
};

const RENDER_MODE_LABELS: Record<StreamRenderingMode, string> = {
  legacy: '整段',
  blocked: '块级',
};

const RENDER_MODE_HINTS: Record<StreamRenderingMode, string> = {
  legacy: '整段：每次更新整块 Markdown，兼容性最好，方便排查基础渲染问题。',
  blocked: '块级：按段落、代码块、公式块拆分重渲，更接近长回答的真实优化路径。',
};

export const getStreamingPresetLabel = (preset: StreamingSmoothingPreset): string =>
  STREAMING_PRESET_LABELS[preset];

export const getStreamingPresetHint = (preset: StreamingSmoothingPreset): string =>
  STREAMING_PRESET_HINTS[preset];

export const getRenderModeLabel = (mode: StreamRenderingMode): string =>
  RENDER_MODE_LABELS[mode];

export const getRenderModeHint = (mode: StreamRenderingMode): string =>
  RENDER_MODE_HINTS[mode];

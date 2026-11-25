import React from 'react';

import {
  HtmlSandboxPreview,
  type HtmlSandboxPreviewProps,
  type SandboxImageClickPayload,
} from './previews/HtmlSandboxPreview';

interface ShadowDomPreviewProps {
  htmlContent: string;
  cssContent: string;
  compact?: boolean;
  height?: number;
  fidelity?: 'default' | 'anki';
  darkMode?: boolean;
  minHeight?: number;
  className?: string;
  onFrameClick?: () => void;
  /** iframe 内点击图片时回调（打开全分辨率缩放灯箱，不翻面） */
  onFrameImageClick?: (payload: SandboxImageClickPayload) => void;
  /** iframe 内点击待加载/重试音频按钮时回调 */
  onFrameSoundClick?: (soundFile: string) => void;
  /** iframe 文档滚不动时的滚轮转发（复习卡面统一 viewport 滚动） */
  onFrameWheel?: (deltaY: number, deltaMode: number) => void;
  /** 应用自有样式（如卡面 KaTeX 样式 + data: 字体），不经模板 CSS 净化 */
  trustedCss?: string;
}

export const ShadowDomPreview: React.FC<ShadowDomPreviewProps> = ({
  htmlContent,
  cssContent,
  compact = false,
  height,
  fidelity = 'default',
  darkMode = false,
  minHeight,
  className,
  onFrameClick,
  onFrameImageClick,
  onFrameSoundClick,
  onFrameWheel,
  trustedCss,
}) => {
  const props: HtmlSandboxPreviewProps = {
    mode: 'template-safe',
    htmlContent,
    cssContent,
    compact,
    height,
    fidelity,
    darkMode,
    title: 'card-preview',
    minHeight,
    className,
    onFrameClick,
    onFrameImageClick,
    onFrameSoundClick,
    onFrameWheel,
    trustedCss,
  };

  return <HtmlSandboxPreview {...props} />;
};

export default ShadowDomPreview;

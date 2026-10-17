import React from 'react';

import {
  HtmlSandboxPreview,
  type HtmlSandboxPreviewProps,
} from './previews/HtmlSandboxPreview';

interface ShadowDomPreviewProps {
  htmlContent: string;
  cssContent: string;
  compact?: boolean;
  height?: number;
  fidelity?: 'default' | 'anki';
  minHeight?: number;
  onFrameClick?: () => void;
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
  minHeight,
  onFrameClick,
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
    title: 'card-preview',
    minHeight,
    onFrameClick,
    onFrameWheel,
    trustedCss,
  };

  return <HtmlSandboxPreview {...props} />;
};

export default ShadowDomPreview;

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
}

export const ShadowDomPreview: React.FC<ShadowDomPreviewProps> = ({
  htmlContent,
  cssContent,
  compact = false,
  height,
  fidelity = 'default',
  minHeight,
  onFrameClick,
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
  };

  return <HtmlSandboxPreview {...props} />;
};

export default ShadowDomPreview;

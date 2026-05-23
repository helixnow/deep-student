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
}

export const ShadowDomPreview: React.FC<ShadowDomPreviewProps> = ({
  htmlContent,
  cssContent,
  compact = false,
  height,
  fidelity = 'default',
}) => {
  const props: HtmlSandboxPreviewProps = {
    mode: 'template-safe',
    htmlContent,
    cssContent,
    compact,
    height,
    fidelity,
    title: 'card-preview',
  };

  return <HtmlSandboxPreview {...props} />;
};

export default ShadowDomPreview;

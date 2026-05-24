import React, { Suspense, lazy, useCallback, useState } from 'react';

import { cn } from '@/lib/utils';

import { UnifiedPreviewToolbar, type ToolbarPreviewType, type SlideNavInfo } from './UnifiedPreviewToolbar';

const DocxPreview = lazy(() => import('./DocxPreview'));
const XlsxPreview = lazy(() => import('./XlsxPreview'));
const PptxPreview = lazy(() => import('./PptxPreview'));

type RichDocumentKind = 'docx' | 'xlsx' | 'pptx';

interface RichDocumentPreviewProps {
  kind: RichDocumentKind;
  base64Content: string;
  fileName: string;
  showToolbar: boolean;
  previewType: ToolbarPreviewType;
  zoomScale: number;
  fontScale: number;
  onZoomChange: (zoom: number) => void;
  onFontChange: (font: number) => void;
  onZoomReset: () => void;
  onFontReset: () => void;
  fallback?: React.ReactNode;
  rootClassName?: string;
  bodyClassName?: string;
}

type SlideNavState = SlideNavInfo | null;

export const RichDocumentPreview: React.FC<RichDocumentPreviewProps> = ({
  kind,
  base64Content,
  fileName,
  showToolbar,
  previewType,
  zoomScale,
  fontScale,
  onZoomChange,
  onFontChange,
  onZoomReset,
  onFontReset,
  fallback = null,
  rootClassName,
  bodyClassName,
}) => {
  const [slideNav, setSlideNav] = useState<SlideNavState>(null);
  const handleSlideInfoChange = useCallback((info: SlideNavState) => {
    setSlideNav(info);
  }, []);

  return (
    <div className={cn('flex flex-col h-full overflow-hidden', rootClassName)}>
      <div className={cn('flex-1 overflow-hidden', bodyClassName)}>
        <Suspense fallback={fallback}>
          {kind === 'docx' && (
            <DocxPreview
              base64Content={base64Content}
              fileName={fileName}
              className="h-full"
              zoomScale={zoomScale}
              fontScale={fontScale}
            />
          )}
          {kind === 'xlsx' && (
            <XlsxPreview
              base64Content={base64Content}
              fileName={fileName}
              className="h-full"
              zoomScale={zoomScale}
              fontScale={fontScale}
            />
          )}
          {kind === 'pptx' && (
            <PptxPreview
              base64Content={base64Content}
              fileName={fileName}
              className="h-full"
              zoomScale={zoomScale}
              onSlideInfoChange={handleSlideInfoChange}
            />
          )}
        </Suspense>
      </div>
      {showToolbar && (
        <UnifiedPreviewToolbar
          previewType={previewType}
          zoomScale={zoomScale}
          fontScale={fontScale}
          onZoomChange={onZoomChange}
          onFontChange={onFontChange}
          onZoomReset={onZoomReset}
          onFontReset={onFontReset}
          slideNav={slideNav}
        />
      )}
    </div>
  );
};

export default RichDocumentPreview;

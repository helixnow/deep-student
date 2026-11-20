import React from 'react';
import { useTranslation } from 'react-i18next';
import { Info } from '@phosphor-icons/react';
import { isMobilePlatform } from '@/utils/platform';
import { PdfSettingsSection } from './PdfSettingsSection';
import { OcrSettingsSection } from './OcrSettingsSection';

/**
 * 文档处理独立设置页（2026-09 自参数调整页拆出）：
 * PDF 渲染与 OCR 识别是独立领域，与模型生成参数无关联。
 * 两个 Section 均自带 GroupTitle/GroupCard。
 */
export const DocumentProcessingTab: React.FC = () => {
  const { t } = useTranslation(['pdf']);
  const isMobile = isMobilePlatform();

  return (
    <div className="space-y-1 pb-10 text-left ui-fade-in-slow">
      <PdfSettingsSection />
      <div className="mt-8 space-y-3">
        {isMobile && (
          <div
            role="note"
            data-testid="mobile-ocr-notice"
            className="flex items-start gap-2.5 rounded-2xl border border-border/60 bg-muted/70 px-3.5 py-3 text-xs leading-relaxed text-muted-foreground sm:px-4"
          >
            <Info size={16} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
            <div className="min-w-0 space-y-0.5">
              <p className="font-medium text-foreground/90">
                {t('pdf:mobile_ocr_notice.title', { defaultValue: '移动端 OCR 识别说明' })}
              </p>
              <p>
                {t('pdf:mobile_ocr_notice.description', {
                  defaultValue:
                    '系统本地 OCR 引擎仅支持桌面端运行。在移动端阅读扫描版文档或识别图片时，建议配置并使用云端 OCR 或多模态视觉模型。',
                })}
              </p>
            </div>
          </div>
        )}
        <OcrSettingsSection />
      </div>
    </div>
  );
};

export default DocumentProcessingTab;

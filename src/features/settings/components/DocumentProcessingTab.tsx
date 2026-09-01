import React from 'react';
import { PdfSettingsSection } from './PdfSettingsSection';
import { OcrSettingsSection } from './OcrSettingsSection';

/**
 * 文档处理独立设置页（2026-09 自参数调整页拆出）：
 * PDF 渲染与 OCR 识别是独立领域，与模型生成参数无关联。
 * 两个 Section 均自带 GroupTitle/GroupCard。
 */
export const DocumentProcessingTab: React.FC = () => {
  return (
    <div className="space-y-1 pb-10 text-left ui-fade-in-slow">
      <PdfSettingsSection />
      <div className="mt-8">
        <OcrSettingsSection />
      </div>
    </div>
  );
};

export default DocumentProcessingTab;

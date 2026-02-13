/**
 * 调试代码片段 - 用于在 EnhancedTemplateEditor.tsx 的 handleSubmit 函数中添加调试逻辑
 *
 * 注意：这是一个代码片段文件，不是独立运行的模块。
 * 下面的代码需要手动复制到 EnhancedTemplateEditor.tsx 中使用。
 */

import React from 'react';
import { CreateTemplateRequest, FieldExtractionRule } from '../types';

// 这些变量应该在 EnhancedTemplateEditor.tsx 中已有定义
declare const validateForm: () => boolean;
declare const setIsSubmitting: (value: boolean) => void;
declare const previewDataJson: string;
declare const validateJson: (json: string) => boolean;
declare const formData: {
  name: string;
  description: string;
  author: string;
  version: string;
  is_active: boolean;
  preview_front: string;
  preview_back: string;
  note_type: string;
  fields: string[];
  generation_prompt: string;
  front_template: string;
  back_template: string;
  css_style: string;
};
declare const fieldExtractionRules: Record<string, FieldExtractionRule>;
declare const onSave: (templateData: CreateTemplateRequest) => Promise<void>;

const handleSubmit = async (e: React.FormEvent) => {
  e.preventDefault();

  if (!validateForm()) {
    return;
  }

  setIsSubmitting(true);

  try {
    // 添加调试日志
    console.log('=== Template Save Debug ===');
    console.log('previewDataJson state:', previewDataJson);
    console.log('Is valid JSON:', validateJson(previewDataJson));

    // 如果 JSON 无效，尝试修复
    let validatedPreviewData = previewDataJson;
    if (!validateJson(previewDataJson)) {
      console.warn('Invalid JSON detected, using empty object');
      validatedPreviewData = '{}';
    }

    const templateData: CreateTemplateRequest = {
      name: formData.name,
      description: formData.description || '',
      author: formData.author || undefined,
      version: formData.version,
      is_active: formData.is_active,
      preview_front: formData.preview_front,
      preview_back: formData.preview_back,
      preview_data_json: validatedPreviewData,  // 使用验证后的数据
      note_type: formData.note_type,
      fields: formData.fields,
      generation_prompt: formData.generation_prompt,
      front_template: formData.front_template,
      back_template: formData.back_template,
      css_style: formData.css_style,
      field_extraction_rules: fieldExtractionRules
    };

    // 打印完整的数据对象
    console.log('Full templateData being saved:', JSON.stringify(templateData, null, 2));
    console.log('preview_data_json field specifically:', templateData.preview_data_json);

    await onSave(templateData);
  } catch (error: unknown) {
    console.error('保存模板失败:', error);
  } finally {
    setIsSubmitting(false);
  }
};

export { handleSubmit };

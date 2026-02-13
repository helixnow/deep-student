/**
 * 模板校验与清洗工具（前端）
 *
 * 提供模板一致性校验、CSS 安全清洗等功能
 */

import { CreateTemplateRequest } from '../types';
import { t } from './i18n';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * 校验模板完整性
 */
export function validateTemplate(template: CreateTemplateRequest): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. 基本字段检查
  if (!template.name || template.name.trim().length === 0) {
    errors.push(t('utils.validation.template_name_required'));
  }

  if (!template.fields || template.fields.length === 0) {
    errors.push(t('utils.validation.template_needs_fields'));
  }

  if (!template.front_template || template.front_template.trim().length === 0) {
    errors.push(t('utils.validation.front_template_required'));
  }

  if (!template.back_template || template.back_template.trim().length === 0) {
    errors.push(t('utils.validation.back_template_required'));
  }

  // 2. 字段与占位符一致性
  const placeholdersFront = extractMustachePlaceholders(template.front_template);
  const placeholdersBack = extractMustachePlaceholders(template.back_template);
  
  const allPlaceholders = new Set([...placeholdersFront, ...placeholdersBack]);
  const fieldsSet = new Set(template.fields.map((f) => f.toLowerCase()));

  for (const placeholder of allPlaceholders) {
    const lower = placeholder.toLowerCase();
    // 忽略特殊占位符
    if (lower === 'frontside') {
      continue;
    }
    if (!fieldsSet.has(lower)) {
      warnings.push(`占位符 {{${placeholder}}} 在字段列表中未定义`);
    }
  }

  // 3. 笔记类型检查
  const validNoteTypes = [
    'Basic',
    'Cloze',
    'Basic (and reversed card)',
    'Basic (optional reversed card)',
  ];
  if (!validNoteTypes.includes(template.note_type)) {
    warnings.push(`笔记类型 '${template.note_type}' 可能不被 Anki 识别`);
  }

  // 4. Cloze 特殊检查
  if (template.note_type === 'Cloze') {
    const hasCloze =
      template.front_template.includes('{{cloze:') ||
      template.back_template.includes('{{cloze:');
    if (!hasCloze) {
      warnings.push('Cloze 笔记类型但模板中未找到 {{cloze:...}} 占位符');
    }

    if (!fieldsSet.has('text')) {
      warnings.push("Cloze 模板建议包含 'Text' 字段");
    }
  }

  // 5. Basic 字段检查
  if (template.note_type.startsWith('Basic')) {
    if (!fieldsSet.has('front')) {
      warnings.push("Basic 模板建议包含 'Front' 字段");
    }
    if (!fieldsSet.has('back')) {
      warnings.push("Basic 模板建议包含 'Back' 字段");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

const MUSTACHE_PLACEHOLDER_REGEX = /\{\{\{?\s*([^}]+?)\s*\}\}\}?/g;

const normalizePlaceholderName = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const prefix = trimmed[0];
  if (prefix === '!') return null;
  let normalized = trimmed;
  if (prefix === '#' || prefix === '^' || prefix === '/') {
    normalized = trimmed.slice(1).trim();
  }
  if (!normalized || normalized === '.') return null;
  normalized = normalized.replace(/^(cloze|text)\s*:\s*/i, '').trim();
  if (!normalized || normalized === '.') return null;
  return normalized;
};

/**
 * 提取 Mustache 占位符
 */
export function extractMustachePlaceholders(template: string): Set<string> {
  const placeholders = new Set<string>();
  let match;
  while ((match = MUSTACHE_PLACEHOLDER_REGEX.exec(template)) !== null) {
    const fieldName = normalizePlaceholderName(match[1]);
    if (fieldName) {
      placeholders.add(fieldName);
    }
  }
  return placeholders;
}

/**
 * CSS 安全清洗
 */
export function sanitizeCSS(css: string): string {
  let sanitized = css;

  // 1. 移除 <script> 标签
  sanitized = sanitized.replace(/<script[^>]*>.*?<\/script>/gi, '');

  // 2. 移除 javascript: URL
  sanitized = sanitized.replace(/javascript:\s*/gi, '');

  // 3. 移除 @import 外链
  sanitized = sanitized.replace(
    /@import\s+url\s*\(\s*['"]?https?:\/\/[^)'"]+['"]?\s*\)/gi,
    ''
  );

  // 4. 移除 expression()
  sanitized = sanitized.replace(/expression\s*\([^)]*\)/gi, '');

  return sanitized;
}

/**
 * 清理 HTML 中的危险内容
 */
export function sanitizeHTML(html: string): string {
  let sanitized = html;

  // 移除 <script> 标签
  sanitized = sanitized.replace(/<script[^>]*>.*?<\/script>/gi, '');

  // 移除事件处理器属性
  sanitized = sanitized.replace(/\son\w+\s*=\s*["'][^"']*["']/gi, '');

  // 移除 javascript: URL
  sanitized = sanitized.replace(/href\s*=\s*["']javascript:[^"']*["']/gi, '');

  return sanitized;
}



import React, { useRef, useEffect } from 'react';
import { AnkiCardTemplate } from '../types';
import Mustache from 'mustache';
import { ShadowDomPreview } from './ShadowDomPreview';
import i18n from '@/i18n';

export const IframePreview = ShadowDomPreview;

// 调试开关 - 设置为false以关闭所有调试日志
const DEBUG_MODE = false;

// 调试日志函数
function debugLog(...args: any[]) {
  if (DEBUG_MODE) {
    console.log(...args);
  }
}

function debugWarn(...args: any[]) {
  if (DEBUG_MODE) {
    console.warn(...args);
  }
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildPlaceholderRegex = (name: string) =>
  new RegExp(`\\{\\{\\s*${escapeRegExp(name)}\\s*\\}\\}`, 'g');

const toSafeString = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(item => {
      if (item === undefined || item === null) return '';
      if (
        typeof item === 'string' ||
        typeof item === 'number' ||
        typeof item === 'boolean' ||
        typeof item === 'bigint'
      ) {
        return String(item);
      }
      try {
        return JSON.stringify(item);
      } catch (error: unknown) {
        return String(item);
      }
    }).join(', ');
  }
  try {
    return JSON.stringify(value);
  } catch (error: unknown) {
    return String(value);
  }
};

const resolveFieldValue = (data: Record<string, any>, rawName: string) => {
  const trimmed = rawName.trim();
  if (Object.prototype.hasOwnProperty.call(data, trimmed)) {
    return { key: trimmed, value: data[trimmed] };
  }
  if (Object.prototype.hasOwnProperty.call(data, rawName)) {
    return { key: rawName, value: data[rawName] };
  }
  const lowered = trimmed.toLowerCase();
  const matchKey = Object.keys(data).find(key => key.toLowerCase() === lowered);
  if (matchKey) {
    return { key: matchKey, value: data[matchKey] };
  }
  return { key: trimmed || rawName, value: undefined };
};

const CLOZE_CONTENT_PATTERN = /\{\{c(\d+)::([^}]+?)\}\}/g;

const parseClozeBody = (body: string) => {
  const hintIndex = body.lastIndexOf('::');
  if (hintIndex === -1) {
    return { text: body, hint: null as string | null };
  }
  const text = body.slice(0, hintIndex);
  const hint = body.slice(hintIndex + 2);
  return { text, hint: hint || null };
};

const applyClozeMarkup = (text: string, showBack: boolean) =>
  text.replace(CLOZE_CONTENT_PATTERN, (_match, _index, body) => {
    const { text: clozeText, hint } = parseClozeBody(body);
    if (showBack) {
      return `<span class="cloze-revealed">${clozeText}</span>`;
    }
    const hintMarkup = hint ? `<span class="cloze-hint">${hint}</span>` : '';
    return `<span class="cloze">[...]</span>${hintMarkup}<span class="cloze-live-reveal">${clozeText}</span>`;
  });

const stripClozeMarkup = (text: string) =>
  text.replace(CLOZE_CONTENT_PATTERN, (_match, _index, body) => parseClozeBody(body).text);

const hasNestedSectionTags = (value: string) =>
  /{{\s*[#^/]\s*(?!\.)[^}]+}}/.test(value);

// 扩展 Window 以静默 TS 对自定义调试字段的报错
declare global {
  interface Window {
    iframeDebugData?: any;
    templateDebugData?: any;
  }
}

export const renderCardPreview = (
  template: string,
  templateData: AnkiCardTemplate,
  actualCardData?: any,
  isBackTemplateOverride?: boolean,
) => {
  // 🎯 SOTA级别修复：使用完整Mustache引擎替代字符串替换
  // 解决复杂模板(ArrayObject, RichText等)渲染问题
  
  // 检测是否为背面模板（允许调用方显式指定）
  const isBackTemplate =
    typeof isBackTemplateOverride === 'boolean' ? isBackTemplateOverride : false;
  const hasActualCardData = !!actualCardData && Object.keys(actualCardData).length > 0;
  
  
  // 🎯 SOTA级别修复：根据模板ID/名称提供完整的示例数据
  // 🌐 i18n: 加载预览数据翻译
  const rawPd = i18n.t('pd', { ns: 'template', returnObjects: true });
  const pd: Record<string, any> = typeof rawPd === 'object' && rawPd !== null ? rawPd : {};

  const getTemplateSpecificData = () => {
    const templateName = templateData.name || '';
    const templateId = templateData.id || '';
    
    // 🔥 优先使用数据库中的预览数据
    if (templateData.preview_data_json) {
      try {
        return JSON.parse(templateData.preview_data_json);
      } catch (e: unknown) {
        debugWarn('Failed to parse preview_data_json:', e);
      }
    }
    
    // 🔥 关键修复：为所有14个模板提供完整的预览数据（兜底方案）
    switch (templateId) {
      case 'minimal-card': {
        const d = pd?.minimal_card || {};
        return {
          'Front': templateData.preview_front || d.Front,
          'Back': templateData.preview_back || d.Back,
          'Notes': d.Notes,
          'Tags': d.Tags,
        };
      }
        
      case 'code-card': {
        const d = pd?.code_card || {};
        return {
          'Question': templateData.preview_front || d.Question,
          'Code': templateData.preview_back || d.Code,
          'Language': d.Language || 'Python',
          'Notes': d.Notes,
          'Tags': d.Tags,
        };
      }
        
      case 'cloze-card': {
        const d = pd?.cloze_card || {};
        return {
          'Text': templateData.preview_front || d.Text,
          'Hint': d.Hint,
          'Notes': d.Notes,
          'Tags': d.Tags,
        };
      }
        
      case 'choice-card': {
        const d = pd?.choice_card || {};
        return {
          'Front': templateData.preview_front || d.Front,
          'Question': templateData.preview_front || d.Front,
          'OptionA': d.OptionA,
          'OptionB': d.OptionB,
          'OptionC': d.OptionC,
          'OptionD': d.OptionD,
          'optiona': d.OptionA,
          'optionb': d.OptionB,
          'optionc': d.OptionC,
          'optiond': d.OptionD,
          'Correct': d.Correct || 'C',
          'correct': d.Correct || 'C',
          'Explanation': templateData.preview_back || d.Explanation,
          'explanation': templateData.preview_back || d.Explanation,
          'Tags': d.Tags,
        };
      }
        
      case 'language-learning-card': {
        const d = pd?.language_learning_card || {};
        return {
          'Word': templateData.preview_front || d.Word,
          'Translation': templateData.preview_back || d.Translation,
          'Pronunciation': d.Pronunciation,
          'Example': d.Example,
          'Grammar': d.Grammar,
          'Context': d.Context,
          'Tags': d.Tags,
        };
      }
        
      case 'medical-terminology-card': {
        const d = pd?.medical_terminology_card || {};
        return {
          'Term': d.Term || 'Hypertension',
          'Translation': d.Translation,
          'Definition': d.Definition,
          'Category': d.Category,
          'Symptoms': d.Symptoms,
          'Treatment': d.Treatment,
          'Tags': d.Tags,
        };
      }
        
      case 'historical-events-card': {
        const d = pd?.historical_events_card || {};
        return {
          'Event': d.Event,
          'Date': d.Date,
          'Location': d.Location,
          'KeyFigures': d.KeyFigures,
          'Causes': d.Causes,
          'Consequences': d.Consequences,
          'Significance': d.Significance,
          'Tags': d.Tags,
        };
      }
        
      case 'math-formulas-card': {
        const d = pd?.math_formulas_card || {};
        return {
          'Formula': d.Formula || 'a² + b² = c²',
          'Name': d.Name,
          'Description': d.Description,
          'Variables': d.Variables,
          'Application': d.Application,
          'Example': d.Example,
          'Tags': d.Tags,
        };
      }
        
      case 'legal-articles-card': {
        const d = pd?.legal_articles_card || {};
        return {
          'Article': d.Article,
          'Law': d.Law,
          'Content': d.Content,
          'Keywords': d.Keywords,
          'Interpretation': d.Interpretation,
          'Tags': d.Tags,
        };
      }
        
      case 'concept-comparison-card': {
        const d = pd?.concept_comparison_card || {};
        return {
          'ConceptA': d.ConceptA,
          'ConceptB': d.ConceptB,
          'Similarities': d.Similarities,
          'DifferencesA': d.DifferencesA,
          'DifferencesB': d.DifferencesB,
          'ApplicationA': d.ApplicationA,
          'ApplicationB': d.ApplicationB,
          'Tags': d.Tags,
        };
      }
        
      case 'multi-step-tutorial': {
        const d = pd?.multi_step_tutorial || {};
        // Steps 中的 code 对象需要保持结构（code 内容不需翻译）
        const steps = Array.isArray(d.Steps) ? d.Steps.map((step: any, idx: number) => ({
          ...step,
          code: idx === 1 ? {
            language: 'bash',
            code: 'git config --global user.name "Your Name"\ngit config --global user.email "your@email.com"'
          } : step.code || undefined,
        })) : [];
        return {
          'Title': templateData.preview_front || d.Title,
          'Overview': d.Overview,
          'Steps': steps,
          'EstimatedTime': d.EstimatedTime,
          'Tips': d.Tips,
          'CommonMistakes': d.CommonMistakes,
          'Tags': d.Tags,
        };
      }
        
      case 'code-debug-exercise': {
        const d = pd?.code_debug_exercise || {};
        return {
          'Title': d.Title,
          'BuggyCode': d.BuggyCode,
          'Language': d.Language || 'Python',
          'ErrorType': d.ErrorType || 'IndexError',
          'ErrorMessage': d.ErrorMessage,
          'CorrectCode': d.CorrectCode,
          'Explanation': d.Explanation,
          'Tags': d.Tags,
        };
      }
        
      case 'data-analysis-comparison': {
        const d = pd?.data_analysis_comparison || {};
        return {
          'Topic': d.Topic,
          'Criteria': d.Criteria,
          'ComparisonItems': d.ComparisonItems,
          'Conclusion': d.Conclusion,
          'Tags': d.Tags,
        };
      }
        
      case 'knowledge-graph': {
        const d = pd?.knowledge_graph || {};
        return {
          'CentralConcept': d.CentralConcept,
          'Definition': d.Definition,
          'Components': d.Components,
          'Relationships': d.Relationships,
          'Tags': d.Tags,
        };
      }
        
      default: {
        // 兜底数据，使用模板的preview数据
        const d = pd?.fallback || {};
        return {
          'Front': templateData.preview_front || d.Front,
          'Back': templateData.preview_back || d.Back,
          'Notes': d.Notes,
          'Tags': d.Tags,
        };
      }
    }
  };

  const specificData = hasActualCardData ? {} : getTemplateSpecificData();
  
  // 🎯 SOTA级别修复：创建支持复杂数据类型的渲染数据
  const defs = pd?.defaults || {};
  const sampleData: Record<string, any> = hasActualCardData ? {} : {
    ...specificData,
    // 保持向后兼容的数据
    'Code': specificData.Code || specificData.BuggyCode || defs.Code,
    'Text': specificData.Text || defs.Text,
    'Hint': specificData.Hint || defs.Hint,
    'Question': specificData.Question || defs.Question,
    'OptionA': specificData.OptionA || defs.OptionA,
    'OptionB': specificData.OptionB || defs.OptionB,
    'OptionC': specificData.OptionC || defs.OptionC,
    'OptionD': specificData.OptionD || defs.OptionD,
    'optiona': specificData.optiona || defs.OptionA,
    'optionb': specificData.optionb || defs.OptionB,
    'optionc': specificData.optionc || defs.OptionC,
    'optiond': specificData.optiond || defs.OptionD,
    'Correct': specificData.Correct || 'C',
    'correct': specificData.correct || 'C',
    'Explanation': specificData.Explanation || defs.Explanation,
    'explanation': specificData.explanation || defs.Explanation
  };
  
  if (actualCardData) {
    // 修复：保留 actualCardData 中所有原始 key（包括不同大小写变体），
    // Mustache 是大小写敏感的，{{Question}} 无法匹配 question。
    Object.keys(actualCardData).forEach(key => {
      sampleData[key] = actualCardData[key];
    });
    
    debugLog('🔍 [SharedPreview] actualCardData merged into sampleData:', sampleData);
  }
  
  // 🔥 关键修复：初始化rendered变量，使用Mustache引擎
  let rendered = template;
  
  // 🎯 调试信息
  debugLog('=== Template Preview Debug ===');
  debugLog('Template ID:', templateData.id);
  debugLog('Template Name:', templateData.name);
  debugLog('Template (first 200 chars):', template.substring(0, 200));
  debugLog('Sample Data Keys:', Object.keys(sampleData));
  
  rendered = rendered.replace(/\{\{cloze:\s*([^}]+?)\s*\}\}/g, (match, rawFieldName) => {
    const { value } = resolveFieldValue(sampleData, rawFieldName);
    const stringValue = toSafeString(value);
    if (stringValue === null) return match;
    return applyClozeMarkup(stringValue, isBackTemplate);
  });
  
  rendered = rendered.replace(/\{\{text:\s*([^}]+?)\s*\}\}/g, (match, rawFieldName) => {
    const { value } = resolveFieldValue(sampleData, rawFieldName);
    const stringValue = toSafeString(value);
    if (stringValue === null) return match;
    return stripClozeMarkup(stringValue);
  });
  
  // 🚨 注意：这里不处理数组，留给后面的 Mustache 预处理器处理
  // 只处理简单的字符串字段
  // 遵循 Mustache section 语义：falsy 值（空字符串/0/false）不渲染 section
  rendered = rendered.replace(/\{\{#\s*([^}]+?)\s*\}\}([\s\S]*?)\{\{\/\s*\1\s*\}\}/g, (match, rawFieldName, content) => {
    const trimmedFieldName = rawFieldName.trim();
    const { value } = resolveFieldValue(sampleData, trimmedFieldName);
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint'
    ) {
      // Mustache section 语义：空字符串/0/false 视为 falsy，不渲染 section
      const strValue = String(value);
      if (strValue === '' || value === false || value === 0) {
        return '';
      }
      return content.replace(buildPlaceholderRegex(trimmedFieldName), strValue);
    }
    // 如果是数组或其他类型，保持原样，让后面的预处理器处理
    return match;
  });
  
  // 根据模板类型设置标签
  const getTemplateTags = () => {
    const templateId = templateData.id || '';
    const tt = pd?.template_tags || {};
    
    if (templateId === 'academic-card') {
      return { array: tt?.academic?.array || [], string: tt?.academic?.string || '' };
    } else if (templateId === 'code-card') {
      return { array: tt?.code?.array || [], string: tt?.code?.string || '' };
    } else if (templateId === 'choice-card') {
      return { array: tt?.choice?.array || [], string: tt?.choice?.string || '' };
    } else if (templateId === 'cloze-card') {
      return { array: tt?.cloze?.array || [], string: tt?.cloze?.string || '' };
    } else {
      return { array: tt?.default?.array || [], string: tt?.default?.string || '' };
    }
  };

  const templateTags = getTemplateTags();
  const tagsValue = (() => {
    const raw = (sampleData as any).Tags ?? (sampleData as any).tags;
    if (raw === undefined || raw === null) return undefined;
    if (Array.isArray(raw)) return raw.join(', ');
    return String(raw);
  })();

  if (typeof tagsValue === 'string') {
    rendered = rendered.replace(/\{\{Tags\}\}/g, tagsValue);
  } else if (!hasActualCardData) {
    rendered = rendered.replace(/\{\{Tags\}\}/g, templateTags.string);
  }
  
  // 🎯 SOTA级别优化：使用Mustache进行最终渲染
  try {
    // 🔥 关键修复：预处理复杂数据类型，确保Mustache兼容性
    const processedData = { ...sampleData };
    
    debugLog('=== Before Mustache Render ===');
    debugLog('Rendered template (pre-Mustache):', rendered.substring(0, 300));
    debugLog('ProcessedData keys:', Object.keys(processedData));
    debugLog('ProcessedData.Steps:', processedData.Steps);
    debugLog('🔍 [SharedPreview] processedData.Tips:', processedData.Tips);
    debugLog('🔍 [SharedPreview] processedData.CommonMistakes:', processedData.CommonMistakes);
    if (DEBUG_MODE) {
      debugLog('🔍 [SharedPreview] Full processedData:', JSON.stringify(processedData, null, 2));
    }
    
    // 处理Tags数组 - 支持多种格式
    if (sampleData.Tags) {
      if (Array.isArray(sampleData.Tags)) {
        processedData['Tags'] = sampleData.Tags.map((tag, index) => ({ 
          name: tag, 
          value: tag,
          '.': tag,  // Mustache {{.}} 支持
          index: index 
        }));
        processedData['TagsString'] = sampleData.Tags.join(', ');
      }
    }
    
    // 处理Steps数组（用于多步骤教程）
    if (sampleData.Steps && Array.isArray(sampleData.Steps)) {
      processedData['Steps'] = sampleData.Steps.map(step => ({
        ...step,
        // 处理嵌套的code对象，确保存在时才渲染
        code: step.code ? {
          language: step.code.language || 'text',
          code: step.code.code || ''
        } : null,
        // 为 Mustache 条件渲染添加布尔标志
        hasDetails: !!step.details,
        hasCode: !!step.code,
        hasWarning: !!step.warning
      }));
    }
    
    // 处理复杂对象数组，直接传递给Mustache
    if (sampleData.ComparisonItems && Array.isArray(sampleData.ComparisonItems)) {
      processedData['ComparisonItems'] = sampleData.ComparisonItems;
    }
    if (sampleData.Components && Array.isArray(sampleData.Components)) {
      processedData['Components'] = sampleData.Components;
    }
    if (sampleData.Relationships && Array.isArray(sampleData.Relationships)) {
      processedData['Relationships'] = sampleData.Relationships;
    }
    
    // 🔥 关键修复：字符串数组直接传递，不需要转换
    // 模板使用 {{#Tips}}...{{#.}}{{.}}{{/.}}...{{/Tips}} 语法
    // 这意味着Tips本身就是字符串数组
    if (sampleData.Tips && Array.isArray(sampleData.Tips)) {
      processedData['Tips'] = sampleData.Tips; // 直接使用字符串数组
    }
    if (sampleData.CommonMistakes && Array.isArray(sampleData.CommonMistakes)) {
      processedData['CommonMistakes'] = sampleData.CommonMistakes; // 直接使用字符串数组
    }
    
    // 处理其他字符串数组，保持原始格式
    if (sampleData.Keywords && Array.isArray(sampleData.Keywords)) {
      processedData['Keywords'] = sampleData.Keywords;
    }
    if (sampleData.Applications && Array.isArray(sampleData.Applications)) {
      processedData['Applications'] = sampleData.Applications;
    }
    if (sampleData.Attributes && Array.isArray(sampleData.Attributes)) {
      processedData['Attributes'] = sampleData.Attributes;
    }
    if (sampleData.Criteria && Array.isArray(sampleData.Criteria)) {
      processedData['Criteria'] = sampleData.Criteria;
    }
    
    // 🔥 使用Mustache进行完整渲染
    debugLog('=== Attempting Mustache Render ===');
    
    // 🎯 关键修复：预处理模板，完全处理所有带有 {{#.}} 的数组语法
    // 这些语法在 Mustache 中会导致 [object Object] 问题
    let preprocessedTemplate = rendered;
    
    debugLog('=== Starting Array Preprocessing ===');
    debugLog('Template contains {{#Tips}}:', template.includes('{{#Tips}}'));
    debugLog('Template contains {{#CommonMistakes}}:', template.includes('{{#CommonMistakes}}'));
    debugLog('processedData.Tips:', processedData.Tips);
    debugLog('processedData.CommonMistakes:', processedData.CommonMistakes);
    
    // 处理所有使用 {{#.}}...{{/.}} 语法的字符串数组
    // 包括: Tips, CommonMistakes, Keywords, Symptoms, Causes, subComponents 等
    const stringArrayFields = [
      'Tips', 'CommonMistakes', 'Keywords', 'Symptoms', 'Causes', 
      'Applications', 'Attributes', 'subComponents', 'pros', 'cons',
      'KeyFigures', 'Variables', 'Steps'
    ];
    
    // 通用处理函数：处理 {{#Field}}...{{#.}}...{{/.}}...{{/Field}} 模式
    stringArrayFields.forEach(fieldName => {
      debugLog(`🔍 [SharedPreview] Processing field: ${fieldName}, data:`, processedData[fieldName]);
      
      // 特殊处理Steps字段 - 它包含复杂对象
      if (fieldName === 'Steps') {
        // 让Mustache正常处理Steps，不进行预处理
        debugLog(`🔍 [SharedPreview] Skipping Steps preprocessing, let Mustache handle it`);
        return;
      }
      
      const data = processedData[fieldName];
      const isPrimitiveArray =
        Array.isArray(data) &&
        data.every(item =>
          item === undefined ||
          item === null ||
          typeof item === 'string' ||
          typeof item === 'number' ||
          typeof item === 'boolean' ||
          typeof item === 'bigint'
        );
      const escapedFieldName = escapeRegExp(fieldName);
      
      // 处理嵌套的 {{#.}} 语法
      const nestedPattern = new RegExp(
        `\\{\\{#${escapedFieldName}\\}\\}([\\s\\S]*?)\\{\\{#\\.\\}\\}([\\s\\S]*?)\\{\\{/\\.\\}\\}([\\s\\S]*?)\\{\\{/${escapedFieldName}\\}\\}`,
        'g'
      );
      
      preprocessedTemplate = preprocessedTemplate.replace(
        nestedPattern,
        (match, before, content, after) => {
          if (!isPrimitiveArray) return match;
          const combined = `${before}${content}${after}`;
          if (hasNestedSectionTags(combined)) return match;
          const items = data.map(item => {
            const itemText = item === undefined || item === null ? '' : String(item);
            return content.replace(/\{\{\.\}\}/g, itemText);
          }).join('');
          if (!items) return '';
          return `${before}${items}${after}`;
        }
      );
      
      // 处理简单的 {{#Field}}...{{/.}}...{{/Field}} 模式（直接使用 {{.}}）
      const simplePattern = new RegExp(
        `\\{\\{#${escapedFieldName}\\}\\}([\\s\\S]*?)\\{\\{/${escapedFieldName}\\}\\}`,
        'g'
      );
      
      preprocessedTemplate = preprocessedTemplate.replace(
        simplePattern,
        (match, content) => {
          // 检查内容中是否包含 {{.}}
          if (content.includes('{{.}}')) {
            if (!isPrimitiveArray) return match;
            if (hasNestedSectionTags(content)) return match;
            const items = data.map(item => {
              const itemText = item === undefined || item === null ? '' : String(item);
              return content.replace(/\{\{\.\}\}/g, itemText);
            }).join('');
            return items ? items : '';
          }
          // 如果不包含 {{.}}，让 Mustache 正常处理
          return match;
        }
      );
    });
    
    // 处理 Criteria 数组（特殊情况，可能不使用嵌套语法）
    preprocessedTemplate = preprocessedTemplate.replace(
      /\{\{#Criteria\}\}([\s\S]*?)\{\{\/Criteria\}\}/g,
      (match, content) => {
        if (content.includes('{{.}}') && processedData.Criteria && Array.isArray(processedData.Criteria)) {
          return processedData.Criteria.map(criterion => 
            content.replace(/\{\{\.\}\}/g, criterion)
          ).join('');
        }
        return match; // 让 Mustache 处理
      }
    );
    
    // 调试：检查预处理后的模板
    debugLog('=== After Array Preprocessing ===');
    debugLog('Preprocessed template contains [object Object]:', preprocessedTemplate.includes('[object Object]'));
    debugLog('Preprocessed template (first 500 chars):', preprocessedTemplate.substring(0, 500));
    
    // ★ 使用processedData进行渲染（已经包含了actualCardData的数据）
    const renderContext = processedData;

    const mustacheRendered = Mustache.render(preprocessedTemplate, renderContext);
    rendered = mustacheRendered;
    debugLog('=== Mustache Render Success ===');
    debugLog('After Mustache:', rendered.substring(0, 300));
    debugLog('Final rendered contains [object Object]:', rendered.includes('[object Object]'));
    
  } catch (error: unknown) {
    debugWarn('Mustache rendering failed, using fallback:', error);
    debugWarn('Template content:', rendered.substring(0, 200), '...');
    debugWarn('Sample data keys:', Object.keys(sampleData));
    
    // 🔥 增强的降级处理：更智能的字符串替换
    Object.entries(sampleData).forEach(([key, value]) => {
      if (!rendered.includes(`{{cloze:${key}}}`) && !rendered.includes(`{{text:${key}}}`)) {
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean' ||
          typeof value === 'bigint'
        ) {
          rendered = rendered.replace(buildPlaceholderRegex(key), String(value));
        } else if (Array.isArray(value)) {
          // 对于数组，尝试更智能的处理
          if (value.length > 0 && typeof value[0] === 'string') {
            rendered = rendered.replace(buildPlaceholderRegex(key), value.join(', '));
          } else if (value.length > 0 && typeof value[0] === 'object') {
            rendered = rendered.replace(buildPlaceholderRegex(key), 
              value.map(item => item.name || item.title || JSON.stringify(item)).join(', '));
          }
        } else if (typeof value === 'object' && value !== null) {
          rendered = rendered.replace(buildPlaceholderRegex(key), 
            value.name || value.title || value.text || JSON.stringify(value));
        }
      }
    });
  }
  
  // 🚨 SOTA修复：不要清理所有未匹配的标记！
  // 只清理特定的无效标记，保留其他正常的Mustache标记
  
  // 清理双点标记（当数组处理失败时）
  rendered = rendered.replace(/\{\{\.\}\}/g, '');
  
  // 🔥 关键修复：不要删除所有未匹配的Mustache标记！
  // 这会导致模板内容被清空
  // rendered = rendered.replace(/\{\{[^}]*\}\}/g, ''); // ❌ 这行会删除所有内容！
  
  debugLog('=== Final Rendered Output (first 300 chars) ===');
  debugLog(rendered.substring(0, 300));
  
  // 🔥 调试：保存渲染结果到剪贴板和文件
  if (DEBUG_MODE && typeof window !== 'undefined' && window.localStorage) {
    const debugOutput = {
      templateId: templateData.id,
      templateName: templateData.name,
      isBackTemplate: isBackTemplate,
      originalTemplate: template,
      renderedHtml: rendered,
      sampleData: sampleData,
      timestamp: new Date().toISOString()
    };

    const debugKey = `template_debug_${templateData.id}_${isBackTemplate ? 'back' : 'front'}`;
    window.localStorage.setItem(debugKey, JSON.stringify(debugOutput, null, 2));
    
    // 添加到全局调试对象
    if (!window.templateDebugData) {
      window.templateDebugData = {};
    }
    window.templateDebugData[debugKey] = debugOutput;
    
    debugLog(`🔍 调试数据已保存到: window.templateDebugData['${debugKey}']`);
    debugLog('使用以下命令导出所有调试数据:');
    debugLog('copy(JSON.stringify(window.templateDebugData, null, 2))');
  }
  
  return rendered;
};

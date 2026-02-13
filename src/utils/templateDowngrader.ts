import { CustomAnkiTemplate } from '../types';
import {
  EnhancedFieldType,
  EnhancedFieldExtractionRule,
  DowngradedResult,
  isComplexFieldType
} from '../types/enhanced-field-types';
import { t } from './i18n';

/**
 * 模板智能降级器
 * 当AI输出无法完全匹配复杂模板时，智能降级处理
 */
export class TemplateDowngrader {
  /**
   * 降级处理AI输出
   */
  static downgrade(
    template: CustomAnkiTemplate,
    aiOutput: any
  ): DowngradedResult {
    // 检测不支持的特性
    const unsupportedFeatures = this.detectUnsupportedFeatures(template, aiOutput);
    
    if (unsupportedFeatures.length === 0) {
      return { 
        success: true, 
        data: aiOutput,
        transformations_applied: []
      };
    }
    
    // 应用降级策略
    return this.applyDowngradeStrategies(template, aiOutput, unsupportedFeatures);
  }

  /**
   * 检测不支持的特性
   */
  private static detectUnsupportedFeatures(
    template: CustomAnkiTemplate,
    aiOutput: any
  ): string[] {
    const features: string[] = [];
    const rules = template.field_extraction_rules || {};

    // 1. 检查深度嵌套
    if (this.hasDeepNesting(aiOutput, 3)) {
      features.push('deep_nesting');
    }

    // 2. 检查复杂数组 - Anki 不支持 ArrayObject 类型
    // 此部分已不再需要，因为我们不再支持 ArrayObject

    // 3. 检查富文本
    Object.entries(rules).forEach(([field, rule]) => {
      if (rule.field_type === EnhancedFieldType.RichText && aiOutput[field]) {
        if (this.containsRichTextElements(aiOutput[field])) {
          features.push('rich_text');
        }
      }
    });

    // 4. 检查过长内容
    if (this.hasOversizedContent(aiOutput)) {
      features.push('oversized_content');
    }

    // 5. 检查特殊字符
    if (this.hasProblematicCharacters(aiOutput)) {
      features.push('special_characters');
    }

    return [...new Set(features)];
  }

  /**
   * 应用降级策略
   */
  private static applyDowngradeStrategies(
    template: CustomAnkiTemplate,
    aiOutput: any,
    unsupportedFeatures: string[]
  ): DowngradedResult {
    let processedData = JSON.parse(JSON.stringify(aiOutput)); // 深拷贝
    const warnings: string[] = [];
    const transformations: string[] = [];

    // 策略1：扁平化嵌套对象
    if (unsupportedFeatures.includes('deep_nesting')) {
      processedData = this.flattenObject(processedData);
      warnings.push(t('utils.warnings.nested_object_flattened'));
      transformations.push('flatten_nested_objects');
    }

    // 策略2：转换对象数组
    if (unsupportedFeatures.includes('array_objects')) {
      processedData = this.convertArrayObjects(processedData, template);
      warnings.push(t('utils.warnings.array_converted_to_text'));
      transformations.push('convert_array_objects');
    }

    // 策略3：简化富文本
    if (unsupportedFeatures.includes('rich_text')) {
      processedData = this.simplifyRichText(processedData, template);
      warnings.push(t('utils.warnings.rich_text_simplified'));
      transformations.push('simplify_rich_text');
    }

    // 策略4：截断过长内容
    if (unsupportedFeatures.includes('oversized_content')) {
      processedData = this.truncateOversizedContent(processedData, template);
      warnings.push(t('utils.warnings.content_truncated'));
      transformations.push('truncate_content');
    }

    // 策略5：清理特殊字符
    if (unsupportedFeatures.includes('special_characters')) {
      processedData = this.cleanSpecialCharacters(processedData);
      warnings.push(t('utils.warnings.special_chars_cleaned'));
      transformations.push('clean_special_characters');
    }

    // 确保必需字段存在
    processedData = this.ensureRequiredFields(processedData, template);

    return {
      success: true,
      data: processedData,
      warnings,
      original: aiOutput,
      transformations_applied: transformations
    };
  }

  /**
   * 检查是否有深度嵌套
   */
  private static hasDeepNesting(obj: any, maxDepth: number): boolean {
    const checkDepth = (item: any, currentDepth: number): boolean => {
      if (currentDepth > maxDepth) return true;
      
      if (typeof item === 'object' && item !== null) {
        if (Array.isArray(item)) {
          return item.some(subItem => checkDepth(subItem, currentDepth + 1));
        } else {
          return Object.values(item).some(value => checkDepth(value, currentDepth + 1));
        }
      }
      
      return false;
    };

    return checkDepth(obj, 0);
  }

  /**
   * 检查是否包含富文本元素
   */
  private static containsRichTextElements(text: any): boolean {
    if (typeof text !== 'string') return false;
    
    // 检查常见的富文本标记
    const richTextPatterns = [
      /<[^>]+>/,          // HTML标签
      /\*\*[^*]+\*\*/,    // Markdown粗体
      /_[^_]+_/,          // Markdown斜体
      /\[[^\]]+\]\([^)]+\)/, // Markdown链接
      /```[^`]+```/       // 代码块
    ];

    return richTextPatterns.some(pattern => pattern.test(text));
  }

  /**
   * 检查是否有过大的内容
   */
  private static hasOversizedContent(obj: any): boolean {
    const MAX_STRING_LENGTH = 5000;
    const MAX_ARRAY_LENGTH = 100;

    const check = (item: any): boolean => {
      if (typeof item === 'string' && item.length > MAX_STRING_LENGTH) {
        return true;
      }
      if (Array.isArray(item) && item.length > MAX_ARRAY_LENGTH) {
        return true;
      }
      if (typeof item === 'object' && item !== null) {
        return Object.values(item).some(value => check(value));
      }
      return false;
    };

    return check(obj);
  }

  /**
   * 检查是否有问题字符
   */
  private static hasProblematicCharacters(obj: any): boolean {
    const problematicPatterns = [
      /[\x00-\x08\x0B\x0C\x0E-\x1F]/, // 控制字符
      /{{[^}]*}}/,                     // Mustache模板语法
      /\x1F/                           // Anki字段分隔符
    ];

    const check = (item: any): boolean => {
      if (typeof item === 'string') {
        return problematicPatterns.some(pattern => pattern.test(item));
      }
      if (typeof item === 'object' && item !== null) {
        return Object.values(item).some(value => check(value));
      }
      return false;
    };

    return check(obj);
  }

  /**
   * 扁平化对象
   */
  private static flattenObject(obj: any, prefix: string = ''): any {
    const flattened: any = {};

    Object.entries(obj).forEach(([key, value]) => {
      const newKey = prefix ? `${prefix}_${key}` : key;
      
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        // 递归扁平化
        Object.assign(flattened, this.flattenObject(value, newKey));
      } else if (Array.isArray(value) && value.some(item => typeof item === 'object')) {
        // 对象数组转换为JSON字符串
        flattened[newKey] = JSON.stringify(value);
      } else {
        flattened[newKey] = value;
      }
    });

    return flattened;
  }

  /**
   * 转换对象数组
   */
  private static convertArrayObjects(data: any, template: CustomAnkiTemplate): any {
    const processed = { ...data };
    const rules = template.field_extraction_rules || {};

    Object.entries(rules).forEach(([field, rule]) => {
      if (!processed) return;
      const targetKey = field;
      const value = processed[targetKey];
      if (!Array.isArray(value)) return;
      if (!value.some(item => typeof item === 'object' && item !== null && !Array.isArray(item))) {
        return;
      }

      const flattened = value
        .map(item => {
          if (item === null || item === undefined) return '';
          if (typeof item !== 'object') return String(item);
          const entries = Object.entries(item)
            .map(([key, val]) => {
              if (val === null || val === undefined) return `${key}:`;
              if (typeof val === 'object') {
                try {
                  return `${key}: ${JSON.stringify(val)}`;
                } catch {
                  return `${key}: ${String(val)}`;
                }
              }
              return `${key}: ${String(val)}`;
            })
            .filter(Boolean)
            .join('; ');
          return entries;
        })
        .filter(line => line && line.trim().length > 0)
        .join('\n');

      processed[targetKey] = flattened;
    });

    return processed;
  }

  /**
   * 简化富文本
   */
  private static simplifyRichText(data: any, template: CustomAnkiTemplate): any {
    const processed = { ...data };
    const rules = template.field_extraction_rules || {};

    Object.entries(rules).forEach(([field, rule]) => {
      if (rule.field_type === EnhancedFieldType.RichText && processed[field]) {
        if (typeof processed[field] === 'string') {
          // 移除HTML标签
          processed[field] = processed[field].replace(/<[^>]+>/g, '');
          
          // 简化Markdown
          processed[field] = processed[field]
            .replace(/\*\*([^*]+)\*\*/g, '$1') // 移除粗体
            .replace(/_([^_]+)_/g, '$1')        // 移除斜体
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // 简化链接
            .replace(/```[^`]*```/g, match => {  // 保留代码块内容
              return match.replace(/```[^`]*\n?/g, '').replace(/\n?```/g, '');
            });
        }
      }
    });

    return processed;
  }

  /**
   * 截断过长内容
   */
  private static truncateOversizedContent(data: any, template: CustomAnkiTemplate): any {
    const MAX_LENGTH = 5000;
    const processed = { ...data };

    const truncate = (obj: any): any => {
      if (typeof obj === 'string' && obj.length > MAX_LENGTH) {
        return obj.substring(0, MAX_LENGTH) + '... [内容已截断]';
      }
      if (Array.isArray(obj) && obj.length > 100) {
        return obj.slice(0, 100);
      }
      if (typeof obj === 'object' && obj !== null) {
        const result: any = {};
        Object.entries(obj).forEach(([key, value]) => {
          result[key] = truncate(value);
        });
        return result;
      }
      return obj;
    };

    return truncate(processed);
  }

  /**
   * 清理特殊字符
   */
  private static cleanSpecialCharacters(data: any): any {
    const clean = (str: string): string => {
      return str
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') // 移除控制字符
        .replace(/\x1F/g, ' ')                         // 替换Anki分隔符
        .replace(/{{([^}]*)}}/g, '[$1]');             // 替换Mustache语法
    };

    const process = (obj: any): any => {
      if (typeof obj === 'string') {
        return clean(obj);
      }
      if (Array.isArray(obj)) {
        return obj.map(item => process(item));
      }
      if (typeof obj === 'object' && obj !== null) {
        const result: any = {};
        Object.entries(obj).forEach(([key, value]) => {
          result[key] = process(value);
        });
        return result;
      }
      return obj;
    };

    return process(data);
  }

  /**
   * 确保必需字段存在
   */
  private static ensureRequiredFields(data: any, template: CustomAnkiTemplate): any {
    const processed = { ...data };
    const rules = template.field_extraction_rules || {};

    const lowerCaseMap = new Map<string, string>();
    Object.keys(processed || {}).forEach(key => {
      lowerCaseMap.set(key.toLowerCase(), key);
    });

    const getKey = (name: string) => lowerCaseMap.get(name.toLowerCase());
    const getValue = (name: string) => {
      const actualKey = getKey(name);
      return actualKey ? processed[actualKey] : processed[name];
    };
    const setValue = (name: string, value: any) => {
      const actualKey = getKey(name) ?? name;
      processed[actualKey] = value;
      lowerCaseMap.set(name.toLowerCase(), actualKey);
    };

    const ensureField = (name: string, candidates: string[], defaultValue: any) => {
      const existingKey = getKey(name);
      const existingValue = existingKey ? processed[existingKey] : undefined;
      if (existingValue !== undefined && existingValue !== null && String(existingValue).trim() !== '') {
        return;
      }
      for (const candidate of candidates) {
        const candidateValue = getValue(candidate);
        if (candidateValue !== undefined && candidateValue !== null && String(candidateValue).trim() !== '') {
          setValue(name, candidateValue);
          return;
        }
      }
      setValue(name, defaultValue);
    };

    ensureField('front', ['front', 'Front', 'title', 'question'], '未知');
    ensureField('back', ['back', 'Back', 'answer', 'content'], '未知');

    Object.entries(rules).forEach(([field, rule]) => {
      if (!rule.is_required) {
        return;
      }
      const existingKey = getKey(field);
      const currentValue = existingKey ? processed[existingKey] : processed[field];
      const hasValue = currentValue !== undefined && currentValue !== null && !(typeof currentValue === 'string' && currentValue.trim() === '');
      if (hasValue) return;

      const defaultValue = rule.default_value !== undefined
        ? rule.default_value
        : (() => {
            switch (rule.field_type) {
              case EnhancedFieldType.Array:
                return [];
              case EnhancedFieldType.Number:
                return 0;
              case EnhancedFieldType.Boolean:
                return false;
              default:
                return '';
            }
          })();

      setValue(field, defaultValue);
    });

    return processed;
  }
}

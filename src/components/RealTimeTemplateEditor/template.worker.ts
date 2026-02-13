import Mustache from 'mustache';
import { CustomAnkiTemplate } from '../../types';

export interface ValidationError {
  severity: 'error' | 'warning';
  message: string;
  field: string;
  line?: number;
  column?: number;
  suggestion?: string;
}

// 模板验证器
class TemplateValidator {
  static validate(template: CustomAnkiTemplate): Map<string, ValidationError[]> {
    const errors = new Map<string, ValidationError[]>();
    
    // 验证前端模板
    errors.set('front', this.validateMustache(template.front_template, 'front'));
    
    // 验证背面模板
    errors.set('back', this.validateMustache(template.back_template, 'back'));
    
    // 验证CSS
    errors.set('css', this.validateCSS(template.css_style));
    
    // 验证字段引用
    this.validateFieldReferences(template, errors);
    
    return errors;
  }
  
  private static validateMustache(template: string, field: string): ValidationError[] {
    const errors: ValidationError[] = [];
    
    try {
      Mustache.parse(template);
    } catch (error: any) {
      errors.push({
        severity: 'error',
        message: `Mustache语法错误: ${error.message}`,
        field,
        line: error.line,
        column: error.column
      });
    }
    
    // 检查常见问题
    if (template.includes('{{/') && !template.includes('{{#')) {
      errors.push({
        severity: 'warning',
        message: '发现结束标签但没有对应的开始标签',
        field,
        suggestion: '检查是否缺少 {{#fieldName}} 开始标签'
      });
    }
    
    // 检查未闭合的标签
    const openTags = (template.match(/\{\{#\w+\}\}/g) || []).length;
    const closeTags = (template.match(/\{\{\/\w+\}\}/g) || []).length;
    if (openTags !== closeTags) {
      errors.push({
        severity: 'error',
        message: `标签不匹配：${openTags}个开始标签，${closeTags}个结束标签`,
        field
      });
    }
    
    return errors;
  }
  
  private static validateCSS(css: string): ValidationError[] {
    const errors: ValidationError[] = [];
    
    if (!css || css.trim() === '') {
      return errors;
    }
    
    // 简单的CSS验证
    const braceCount = (css.match(/{/g) || []).length - (css.match(/}/g) || []).length;
    if (braceCount !== 0) {
      errors.push({
        severity: 'error',
        message: '大括号不匹配',
        field: 'css'
      });
    }
    
    // 检查常见CSS错误
    if (css.includes(';;')) {
      errors.push({
        severity: 'warning',
        message: '发现重复的分号',
        field: 'css',
        suggestion: '移除多余的分号'
      });
    }
    
    // 检查无效的CSS属性值
    const invalidPatterns = [
      { pattern: /:\s*;/g, message: '发现空的CSS属性值' },
      { pattern: /{\s*}/g, message: '发现空的CSS规则块' }
    ];
    
    invalidPatterns.forEach(({ pattern, message }) => {
      if (pattern.test(css)) {
        errors.push({
          severity: 'warning',
          message,
          field: 'css'
        });
      }
    });
    
    return errors;
  }
  
  private static validateFieldReferences(
    template: CustomAnkiTemplate,
    errors: Map<string, ValidationError[]>
  ) {
    const definedFields = new Set(template.fields);
    const usedFields = new Set<string>();
    
    // 提取使用的字段
    const extractFields = (content: string) => {
      const regex = /\{\{#?\/?([^}]+)\}\}/g;
      let match;
      while ((match = regex.exec(content)) !== null) {
        const field = match[1].trim();
        if (!field.startsWith('#') && !field.startsWith('/')) {
          usedFields.add(field);
        }
      }
    };
    
    extractFields(template.front_template);
    extractFields(template.back_template);
    
    // 检查未定义的字段
    usedFields.forEach(field => {
      if (!definedFields.has(field)) {
        const frontErrors = errors.get('front') || [];
        const backErrors = errors.get('back') || [];
        
        if (template.front_template.includes(`{{${field}}}`)) {
          frontErrors.push({
            severity: 'warning',
            message: `引用了未定义的字段: ${field}`,
            field: 'front',
            suggestion: `在字段列表中添加 "${field}"`
          });
        }
        
        if (template.back_template.includes(`{{${field}}}`)) {
          backErrors.push({
            severity: 'warning',
            message: `引用了未定义的字段: ${field}`,
            field: 'back',
            suggestion: `在字段列表中添加 "${field}"`
          });
        }
        
        errors.set('front', frontErrors);
        errors.set('back', backErrors);
      }
    });
    
    // 检查未使用的字段
    definedFields.forEach(field => {
      if (!usedFields.has(field)) {
        const fieldErrors = errors.get('fields') || [];
        fieldErrors.push({
          severity: 'warning',
          message: `字段 "${field}" 已定义但未使用`,
          field: 'fields',
          suggestion: '考虑在模板中使用此字段或将其删除'
        });
        errors.set('fields', fieldErrors);
      }
    });
  }
}

// 处理主线程消息
self.addEventListener('message', async (event) => {
  const { type, template, previewData, requestId } = event.data;
  
  if (type === 'compile') {
    try {
      // 验证模板
      const errors = TemplateValidator.validate(template);
      
      // 渲染预览
      const rendered: Record<string, string> = {};
      
      try {
        rendered.front = Mustache.render(template.front_template, previewData);
      } catch (error: any) {
        rendered.front = `<div class="render-error">渲染错误: ${error.message}</div>`;
      }
      
      try {
        rendered.back = Mustache.render(template.back_template, previewData);
      } catch (error: any) {
        rendered.back = `<div class="render-error">渲染错误: ${error.message}</div>`;
      }
      
      // 将Map转换为普通对象以便序列化
      const errorsObj: Record<string, ValidationError[]> = {};
      errors.forEach((value, key) => {
        errorsObj[key] = value;
      });
      
      self.postMessage({
        type: 'compiled',
        data: {
          rendered,
          errors: errorsObj
        },
        requestId
      });
    } catch (error: any) {
      self.postMessage({
        type: 'error',
        data: error.message,
        requestId
      });
    }
  }
});

// TypeScript编译器需要导出
export {};
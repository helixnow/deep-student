import { CustomAnkiTemplate, FieldExtractionRule, ValidationRule } from '../types';
import {
  EnhancedFieldType
} from '../types/enhanced-field-types';

/**
 * 增强的AI Prompt生成器
 * 为复杂模板生成更精确的提示词
 *
 * NOTE: Chinese strings in this file are intentional LLM prompt content.
 * They are sent directly to Chinese-language AI models for Anki card generation
 * and should NOT be wrapped in i18n t() calls.
 */
export class EnhancedPromptGenerator {
  /**
   * 生成增强的提示词
   */
  /**
   * 生成简洁有效的提示词
   * 参考独立模块的成功模式：协议指令放在最前面，保持简洁
   */
  static generatePrompt(template: CustomAnkiTemplate): string {
    const basePrompt = template.generation_prompt || '';
    const exampleJson = this.generateRawExampleJSON(template);
    
    // 🔧 模式约束：明确当前处于制卡模式
    const modeConstraint = [
      '【重要：制卡模式已激活】',
      '当前会话正处于 Anki 制卡模式。请严格遵守以下规则：',
      '1. 只输出卡片JSON，不要输出任何正文、解释或其他内容',
      '2. 不要输出与卡片无关的文字、符号或标记',
      '3. 每张卡片必须使用完整的开始和结束标记包裹',
    ].join('\n');
    
    // 🔧 简化协议：参考独立模块的成功模式，只保留核心指令
    const streamingProtocol = [
      '【输出格式 - 必须严格遵守】',
      '',
      '每张卡片按以下格式输出，禁止使用 Markdown 代码块，禁止输出任何其他内容：',
      '',
      '<<<ANKI_CARD_JSON_START>>>',
      exampleJson,
      '<<<ANKI_CARD_JSON_END>>>',
      '',
      '多张卡片连续输出，每张都需要完整的开始和结束标记。',
      '禁止在卡片之间或之外输出任何文字或符号。',
    ].join('\n');

    // 简化：只返回模式约束 + 基础 prompt + 协议
    return [modeConstraint, basePrompt, streamingProtocol].filter(Boolean).join('\n\n');
  }
  
  /**
   * 生成完整的增强提示词（包含所有约束，用于高级场景）
   */
  static generateFullPrompt(template: CustomAnkiTemplate): string {
    const basePrompt = template.generation_prompt || '';
    const enhancedParts: string[] = [];

    const fieldsRequirement = this.generateFieldsRequirement(template);
    const exampleJson = this.generateRawExampleJSON(template);
    const streamingProtocol = [
      '【输出格式 - 必须严格遵守】',
      '',
      '每张卡片按以下格式输出：',
      '1. 开始标记：<<<ANKI_CARD_JSON_START>>>',
      '2. 纯JSON内容（禁止使用 Markdown 代码块）',
      '3. 结束标记：<<<ANKI_CARD_JSON_END>>>',
      '',
      `字段要求：${fieldsRequirement}`,
      '',
      '示例：',
      '<<<ANKI_CARD_JSON_START>>>',
      exampleJson,
      '<<<ANKI_CARD_JSON_END>>>',
    ].join('\n');

    enhancedParts.push(this.generateTypeConstraints(template));
    enhancedParts.push(this.generateValidationRules(template));
    enhancedParts.push(this.generateCommonMistakes(template));
    enhancedParts.push(this.generateBestPractices(template));

    return [basePrompt, streamingProtocol, ...enhancedParts.filter(Boolean)].join('\n\n');
  }

  private static generateRawExampleJSON(template: CustomAnkiTemplate): string {
    const example: any = {};
    const rules = template.field_extraction_rules || {};
    Object.entries(rules).forEach(([field, rule]) => {
      example[field] = this.generateExampleValue(rule);
    });
    return JSON.stringify(example, null, 2);
  }

  private static generateFieldsRequirement(template: CustomAnkiTemplate): string {
    const fields = Array.isArray(template.fields) ? template.fields : [];
    const mapped = fields.map(f => {
      const lower = f.toLowerCase();
      if (lower === 'front') return 'front（字符串）：问题或概念';
      if (lower === 'back') return 'back（字符串）：答案或解释';
      if (lower === 'tags') return 'tags（字符串数组）：相关标签';
      return `${lower}（字符串，可选）：${f}`;
    });
    return mapped.join('、');
  }

  /**
   * 生成类型约束说明
   */
  private static generateTypeConstraints(template: CustomAnkiTemplate): string {
    const rules = template.field_extraction_rules || {};
    const constraints: string[] = [];

    constraints.push('## 字段类型要求\n');
    constraints.push('请严格遵守以下字段类型定义：\n');

    Object.entries(rules).forEach(([field, rule]) => {
      const typeDesc = this.getTypeDescription(rule);
      const required = rule.is_required ? '【必需】' : '【可选】';
      
      constraints.push(`- **${field}** ${required}: ${typeDesc}`);
      
      // 添加额外约束
      if (rule.validation) {
        if (rule.validation.min !== undefined || rule.validation.max !== undefined) {
          const range = this.formatRange(rule.validation.min, rule.validation.max, rule.field_type);
          constraints.push(`  - 范围: ${range}`);
        }
        if (rule.validation.pattern) {
          constraints.push(`  - 格式: 必须匹配正则表达式 \`${rule.validation.pattern}\``);
        }
        if ((rule.validation as any).enum || (rule.validation as any).enum_values) {
          const enumValues = (rule.validation as any).enum || (rule.validation as any).enum_values;
          constraints.push(`  - 允许值: ${enumValues.join(', ')}`);
        }
      }

      if ((rule as any).max_length) {
        constraints.push(`  - 最大长度: ${(rule as any).max_length} 字符`);
      }

      if (rule.ai_hint) {
        constraints.push(`  - 提示: ${rule.ai_hint}`);
      }
    });

    return constraints.join('\n');
  }

  /**
   * 生成示例JSON
   */
  private static generateExampleJSON(template: CustomAnkiTemplate): string {
    const example: any = {};
    const rules = template.field_extraction_rules || {};

    // 生成每个字段的示例值
    Object.entries(rules).forEach(([field, rule]) => {
      example[field] = this.generateExampleValue(rule);
    });

    return `## JSON格式示例

请严格按照以下格式生成JSON，不要添加额外的字段：

\`\`\`json
${JSON.stringify(example, null, 2)}
\`\`\`

**重要提示**：
- 确保JSON格式正确，所有字符串都用双引号包围
- 不要在JSON中包含注释
- 数组和对象字段即使为空也要保留（使用 [] 或 {}）
- 特殊字符需要正确转义（如 \\" 表示引号）`;
  }

  /**
   * 生成验证规则说明
   */
  private static generateValidationRules(template: CustomAnkiTemplate): string {
    const rules = template.field_extraction_rules || {};
    const validationRules: string[] = [];
    
    // 收集所有有验证规则的字段
    const fieldsWithValidation = Object.entries(rules).filter(
      ([_, rule]) => rule.validation || (rule as any).depends_on || (rule as any).allowed_values
    );

    if (fieldsWithValidation.length === 0) {
      return '';
    }

    validationRules.push('## 验证规则\n');

    fieldsWithValidation.forEach(([field, rule]) => {
      validationRules.push(`### ${field} 字段验证要求：`);

      if (rule.validation?.error_message) {
        validationRules.push(`- ${rule.validation.error_message}`);
      }

      if ((rule as any).depends_on) {
        validationRules.push(`- 此字段依赖于 "${(rule as any).depends_on}" 字段的值`);
      }

      if ((rule as any).allowed_values) {
        validationRules.push(`- 只能使用以下值之一: ${(rule as any).allowed_values.join(', ')}`);
      }
    });

    return validationRules.join('\n');
  }

  /**
   * 生成常见错误警告
   */
  private static generateCommonMistakes(template: CustomAnkiTemplate): string {
    const mistakes: string[] = [];
    const rules = template.field_extraction_rules || {};

    mistakes.push('## ⚠️ 避免以下常见错误\n');

    // 1. 复杂类型相关错误 - Anki 不支持复杂类型，此部分已过时
    // 注释掉复杂类型的检查，因为我们已不再支持这些类型

    // 2. 必需字段相关
    const requiredFields = Object.entries(rules)
      .filter(([_, rule]) => rule.is_required)
      .map(([field, _]) => field);

    if (requiredFields.length > 0) {
      mistakes.push('\n### 必需字段遗漏：');
      mistakes.push(`- 以下字段必须提供: ${requiredFields.join(', ')}`);
      mistakes.push('- 即使内容为空，也要提供空字符串 "" 或空数组 []');
    }

    // 3. 特殊字符处理
    mistakes.push('\n### 特殊字符处理：');
    mistakes.push('- 避免使用未转义的引号、反斜杠等特殊字符');
    mistakes.push('- 不要在字符串中包含制表符或换行符（使用 \\t 和 \\n）');
    mistakes.push('- 避免使用 {{}} 这样的模板语法，会与Anki冲突');

    // 4. 数组处理
    const arrayFields = Object.entries(rules).filter(
      ([_, rule]) => rule.field_type === 'Array'
    );

    if (arrayFields.length > 0) {
      mistakes.push('\n### 数组字段错误：');
      mistakes.push('- 数组字段不能是逗号分隔的字符串，必须是真正的JSON数组');
      mistakes.push('- 空数组应该写作 []，而不是 null 或省略');
    }

    return mistakes.join('\n');
  }

  /**
   * 生成最佳实践
   */
  private static generateBestPractices(template: CustomAnkiTemplate): string {
    const practices: string[] = [];
    const rules = template.field_extraction_rules || {};

    practices.push('## 📚 最佳实践\n');

    // 1. 内容质量
    practices.push('### 内容质量：');
    practices.push('- 确保生成的内容准确、相关、有教育价值');
    practices.push('- 避免过于简单或过于复杂的内容');
    practices.push('- 保持一致的难度级别');

    // 2. 格式规范
    practices.push('\n### 格式规范：');
    practices.push('- 保持字段内容的格式一致性');
    practices.push('- 使用清晰的标点符号和段落结构');
    
    // 3. 针对特定字段类型的建议
    // 代码字段不再支持，但可以使用文本字段存储代码

    const hasFormula = Object.values(rules).some(r => r.field_type === 'Formula');
    if (hasFormula) {
      practices.push('\n### 公式字段：');
      practices.push('- 使用标准的LaTeX语法');
      practices.push('- 确保所有括号、大括号都正确配对');
      practices.push('- 复杂公式考虑分行显示');
    }

    // 4. 标签使用
    if (template.fields.includes('Tags') || template.fields.includes('tags')) {
      practices.push('\n### 标签使用：');
      practices.push('- 使用描述性的标签，便于分类和搜索');
      practices.push('- 避免过多标签（建议3-5个）');
      practices.push('- 使用统一的标签命名规范');
    }

    return practices.join('\n');
  }

  /**
   * 获取类型描述
   */
  private static getTypeDescription(rule: FieldExtractionRule): string {
    const baseType = this.getBaseTypeDescription(rule.field_type);
    
    // Anki 不支持复杂类型，不再需要 Schema
    
    return `${baseType} - ${rule.description}`;
  }

  /**
   * 获取基础类型描述
   */
  private static getBaseTypeDescription(type: string): string {
    const typeMap: Record<string, string> = {
      'Text': '文本字符串',
      'Array': '字符串数组',
      'Number': '数字',
      'Boolean': '布尔值（true/false）',
      'Date': '日期时间（ISO 8601格式）',
      'RichText': '富文本（支持Markdown）',
      'Formula': 'LaTeX公式'
    };

    return typeMap[type] || '文本字符串';
  }

  /**
   * 生成示例值
   */
  private static generateExampleValue(rule: FieldExtractionRule): any {
    // 如果有默认值，优先使用
    if (rule.default_value !== undefined && rule.default_value !== null) {
      return rule.default_value;
    }

    // 根据类型生成示例
    switch (rule.field_type) {
      case 'Text':
        return rule.description || '示例文本';
      
      case 'Array':
        return ['项目1', '项目2', '项目3'];
      
      case 'Number':
        return rule.validation?.min || 1;
      
      case 'Boolean':
        return true;
      
      case 'Date':
        return new Date().toISOString();
      
      case 'RichText':
        return '**粗体文本** 和 *斜体文本*\\n\\n- 列表项1\\n- 列表项2';
      
      case 'Formula':
        return '$E = mc^2$';
      
      default:
        return '';
    }
  }

  /**
   * 格式化范围
   */
  private static formatRange(min?: number, max?: number, type?: string): string {
    if (min !== undefined && max !== undefined) {
      return `${min} 到 ${max}`;
    } else if (min !== undefined) {
      return `最小值 ${min}`;
    } else if (max !== undefined) {
      return `最大值 ${max}`;
    }
    return '无限制';
  }
}

import { CustomAnkiTemplate, FieldExtractionRule } from '../types';
import {
  ComplexityReport,
  ComplexityLevel,
  ComplexityIssue,
  EnhancedFieldType
} from '../types/enhanced-field-types';
import { t } from './i18n';

/**
 * 模板复杂度分析器
 * 评估模板的复杂度并提供优化建议
 */
export class TemplateComplexityAnalyzer {
  // 复杂度权重配置
  private static readonly WEIGHTS = {
    fieldCount: 2,
    simpleField: 2,
    // objectField: 10, // Anki 不支持
    // arrayObjectField: 15, // Anki 不支持
    // computedField: 20, // Anki 不支持
    nestedDepth: 10,
    validationRule: 3,
    dependency: 5,
    customFunction: 8
  };

  // 复杂度级别阈值
  private static readonly THRESHOLDS = {
    simple: 20,
    moderate: 40,
    complex: 60,
    veryComplex: 80
  };

  /**
   * 分析模板复杂度
   */
  static analyze(template: CustomAnkiTemplate): ComplexityReport {
    const score = this.calculateScore(template);
    const issues = this.detectIssues(template);
    const suggestions = this.generateSuggestions(template, issues);
    const level = this.getLevel(score);
    const successRate = this.estimateSuccessRate(score);

    return {
      score,
      level,
      issues,
      suggestions,
      estimated_success_rate: successRate,
      recommended_downgrade: score > this.THRESHOLDS.complex && issues.some(i => i.severity === 'high')
    };
  }

  /**
   * 计算复杂度分数
   */
  private static calculateScore(template: CustomAnkiTemplate): number {
    let score = 0;

    // 1. 字段数量
    score += template.fields.length * this.WEIGHTS.fieldCount;

    // 2. 字段类型复杂度
    const rules = template.field_extraction_rules || {};
    Object.values(rules).forEach(rule => {
      score += this.getFieldTypeScore(rule);
    });

    // 3. 嵌套深度
    const nestingDepth = this.calculateNestingDepth(rules);
    score += nestingDepth * this.WEIGHTS.nestedDepth;

    // 4. 验证规则复杂度
    const validationComplexity = this.calculateValidationComplexity(rules);
    score += validationComplexity;

    // 5. 依赖关系复杂度
    const dependencyComplexity = this.calculateDependencyComplexity(rules);
    score += dependencyComplexity;

    // 6. 模板复杂度
    const templateComplexity = this.analyzeTemplateComplexity(template);
    score += templateComplexity;

    return Math.min(100, Math.round(score));
  }

  /**
   * 获取字段类型的复杂度分数
   */
  private static getFieldTypeScore(rule: FieldExtractionRule): number {
    switch (rule.field_type) {
      case EnhancedFieldType.Formula:
      case EnhancedFieldType.RichText:
        return this.WEIGHTS.simpleField * 2;
      default:
        return this.WEIGHTS.simpleField;
    }
  }

  /**
   * 计算嵌套深度
   */
  private static calculateNestingDepth(rules: Record<string, FieldExtractionRule>): number {
    let maxDepth = 0;

    const calculateDepth = (rule: FieldExtractionRule, currentDepth: number = 0): number => {
      if (rule.schema?.properties) {
        const depths = Object.values(rule.schema.properties).map(
          subRule => calculateDepth(subRule, currentDepth + 1)
        );
        return Math.max(...depths, currentDepth + 1);
      }
      if (rule.item_schema?.properties) {
        const depths = Object.values(rule.item_schema.properties).map(
          subRule => calculateDepth(subRule, currentDepth + 1)
        );
        return Math.max(...depths, currentDepth + 1);
      }
      return currentDepth;
    };

    Object.values(rules).forEach(rule => {
      const depth = calculateDepth(rule);
      maxDepth = Math.max(maxDepth, depth);
    });

    return maxDepth;
  }

  /**
   * 计算验证规则复杂度
   */
  private static calculateValidationComplexity(rules: Record<string, FieldExtractionRule>): number {
    let complexity = 0;

    Object.values(rules).forEach(rule => {
      if (rule.validation) {
        complexity += this.WEIGHTS.validationRule;
        if (rule.validation.custom) {
          complexity += this.WEIGHTS.customFunction;
        }
        if (rule.validation.pattern) {
          // 正则表达式复杂度
          const patternLength = rule.validation.pattern.length;
          complexity += Math.min(patternLength / 10, 5);
        }
      }
    });

    return complexity;
  }

  /**
   * 计算依赖关系复杂度
   */
  private static calculateDependencyComplexity(rules: Record<string, FieldExtractionRule>): number {
    let complexity = 0;
    const dependencies = new Map<string, string[]>();

    // 构建依赖图
    Object.entries(rules).forEach(([field, rule]) => {
      const dependsOn = (rule as any).depends_on;
      if (dependsOn) {
        if (!dependencies.has(dependsOn)) {
          dependencies.set(dependsOn, []);
        }
        dependencies.get(dependsOn)!.push(field);
        complexity += this.WEIGHTS.dependency;
      }
    });

    // 检查循环依赖
    if (this.hasCircularDependency(dependencies)) {
      complexity += 20; // 循环依赖严重增加复杂度
    }

    return complexity;
  }

  /**
   * 分析模板复杂度
   */
  private static analyzeTemplateComplexity(template: CustomAnkiTemplate): number {
    let complexity = 0;

    // 分析前后模板
    const templates = [template.front_template, template.back_template];
    templates.forEach(tmpl => {
      // 统计Mustache标签数量
      const tagMatches = tmpl.match(/\{\{[^}]+\}\}/g) || [];
      complexity += tagMatches.length;

      // 统计条件和循环
      const conditionals = tmpl.match(/\{\{#[^}]+\}\}/g) || [];
      const loops = tmpl.match(/\{\{#[^}]+\}\}[\s\S]*?\{\{\/[^}]+\}\}/g) || [];
      complexity += conditionals.length * 2;
      complexity += loops.length * 3;
    });

    // CSS复杂度
    const cssLines = template.css_style.split('\n').length;
    complexity += Math.min(cssLines / 20, 10);

    return complexity;
  }

  /**
   * 检测问题
   */
  private static detectIssues(template: CustomAnkiTemplate): ComplexityIssue[] {
    const issues: ComplexityIssue[] = [];
    const rules = template.field_extraction_rules || {};

    // 1. 检查字段数量
    if (template.fields.length > 15) {
      issues.push({
        type: 'too_many_fields',
        severity: 'medium',
        message: `模板包含 ${template.fields.length} 个字段，可能过于复杂`
      });
    }

    // 2. 检查深度嵌套
    const nestingDepth = this.calculateNestingDepth(rules);
    if (nestingDepth > 2) {
      issues.push({
        type: 'deep_nesting',
        severity: 'high',
        message: `嵌套深度达到 ${nestingDepth} 层，可能导致解析困难`
      });
    }

    // 3. 检查复杂类型使用 - Anki 不再支持复杂类型
    // isComplexFieldType 现在总是返回 false
    // 此检查已不再需要

    // 4. 检查循环依赖
    const dependencies = new Map<string, string[]>();
    Object.entries(rules).forEach(([field, rule]) => {
      const dependsOn = (rule as any).depends_on;
      if (dependsOn) {
        if (!dependencies.has(dependsOn)) {
          dependencies.set(dependsOn, []);
        }
        dependencies.get(dependsOn)!.push(field);
      }
    });

    if (this.hasCircularDependency(dependencies)) {
      issues.push({
        type: 'circular_dependency',
        severity: 'high',
        message: t('utils.warnings.circular_dependency')
      });
    }

    // 5. 检查性能风险 - ArrayObject 已不再支持
    // 此部分已不再需要

    return issues;
  }

  /**
   * 生成优化建议
   */
  private static generateSuggestions(template: CustomAnkiTemplate, issues: ComplexityIssue[]): string[] {
    const suggestions: string[] = [];

    // 基于问题生成建议
    issues.forEach(issue => {
      switch (issue.type) {
        case 'too_many_fields':
          suggestions.push('考虑将模板拆分为多个更简单的模板');
          suggestions.push('移除非必要的字段，或将部分字段合并');
          break;

        case 'deep_nesting':
          suggestions.push('尝试扁平化数据结构，减少嵌套层级');
          suggestions.push('考虑使用字符串化的JSON代替深层嵌套对象');
          break;

        case 'complex_types':
          suggestions.push('评估是否所有复杂类型都是必需的');
          suggestions.push('考虑使用更简单的字段类型替代');
          break;

        case 'circular_dependency':
          suggestions.push('重新设计字段依赖关系，避免循环引用');
          suggestions.push('考虑使用计算字段替代复杂的依赖关系');
          break;

        // ArrayObject 相关建议已不再需要
        // case 'performance_risk':
        //   break;
      }
    });

    // 通用建议
    const score = this.calculateScore(template);
    if (score > this.THRESHOLDS.complex) {
      suggestions.push('为AI生成提供详细的示例JSON，确保输出格式正确');
      suggestions.push('在模板描述中明确说明每个字段的用途和格式要求');
      suggestions.push('考虑提供简化版本的模板作为备选方案');
    }

    // 去重
    return [...new Set(suggestions)];
  }

  /**
   * 获取复杂度级别
   */
  private static getLevel(score: number): ComplexityLevel {
    if (score <= this.THRESHOLDS.simple) return ComplexityLevel.Simple;
    if (score <= this.THRESHOLDS.moderate) return ComplexityLevel.Moderate;
    if (score <= this.THRESHOLDS.complex) return ComplexityLevel.Complex;
    return ComplexityLevel.VeryComplex;
  }

  /**
   * 估算成功率
   */
  private static estimateSuccessRate(score: number): number {
    // 基于分数的成功率估算
    if (score <= 20) return 0.95;
    if (score <= 40) return 0.85;
    if (score <= 60) return 0.70;
    if (score <= 80) return 0.50;
    return 0.30;
  }

  /**
   * 检查循环依赖
   */
  private static hasCircularDependency(dependencies: Map<string, string[]>): boolean {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const hasCycle = (node: string): boolean => {
      visited.add(node);
      recursionStack.add(node);

      const neighbors = dependencies.get(node) || [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          if (hasCycle(neighbor)) return true;
        } else if (recursionStack.has(neighbor)) {
          return true;
        }
      }

      recursionStack.delete(node);
      return false;
    };

    for (const node of dependencies.keys()) {
      if (!visited.has(node)) {
        if (hasCycle(node)) return true;
      }
    }

    return false;
  }

  /**
   * 获取复杂度报告的中文描述
   */
  static getReportSummary(report: ComplexityReport): string {
    const levelMap = {
      [ComplexityLevel.Simple]: t('utils.complexity.simple'),
      [ComplexityLevel.Moderate]: t('utils.complexity.moderate'),
      [ComplexityLevel.Complex]: t('utils.complexity.complex'),
      [ComplexityLevel.VeryComplex]: t('utils.complexity.very_complex')
    };

    const summary = [`模板复杂度: ${levelMap[report.level]} (${report.score}分)`];
    summary.push(`预估成功率: ${Math.round(report.estimated_success_rate * 100)}%`);

    if (report.issues.length > 0) {
      summary.push(`\n发现 ${report.issues.length} 个潜在问题:`);
      report.issues.forEach(issue => {
        const severityMap = { low: '低', medium: '中', high: '高' };
        summary.push(`- [${severityMap[issue.severity]}] ${issue.message}`);
      });
    }

    if (report.suggestions.length > 0) {
      summary.push(`\n优化建议:`);
      report.suggestions.forEach(suggestion => {
        summary.push(`- ${suggestion}`);
      });
    }

    if (report.recommended_downgrade) {
      summary.push(`\n⚠️ 建议简化模板以提高可靠性`);
    }

    return summary.join('\n');
  }
}
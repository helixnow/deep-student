import { AnkiCardTemplate, CustomAnkiTemplate, FieldExtractionRule } from '../types';
import { getErrorMessage } from '../utils/errorUtils';
import { templateManager } from '../data/ankiTemplates';
import { EnhancedPromptGenerator } from '../utils/enhancedPromptGenerator';
import { TemplateComplexityAnalyzer } from '../utils/templateComplexityAnalyzer';
import { TemplateDowngrader } from '../utils/templateDowngrader';
import { checkAndImportTemplates } from '../utils/importNewTemplates';

/**
 * 模板服务 - 提供模板管理的统一接口
 * 整合了所有增强功能：复杂度分析、智能降级、增强提示词生成等
 */
export class TemplateService {
  private static instance: TemplateService;
  private initialized = false;

  private constructor() {}

  public static getInstance(): TemplateService {
    if (!TemplateService.instance) {
      TemplateService.instance = new TemplateService();
    }
    return TemplateService.instance;
  }

  /**
   * 初始化模板服务
   * 自动导入复杂模板示例
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    try {
      await checkAndImportTemplates();
      this.initialized = true;
    } catch (error: unknown) {
      console.error('Template service initialization failed:', error);
      throw error;
    }
  }

  // ── 基础模板管理 ──

  /**
   * 获取所有模板
   */
  async getAllTemplates(): Promise<CustomAnkiTemplate[]> {
    return templateManager.getAllTemplates();
  }

  /**
   * 根据ID获取模板
   */
  async getTemplateById(id: string): Promise<CustomAnkiTemplate | null> {
    const templates = await this.getAllTemplates();
    return templates.find(t => t.id === id) || null;
  }

  /**
   * 获取默认模板
   */
  async getDefaultTemplate(): Promise<CustomAnkiTemplate> {
    return templateManager.getDefaultTemplate();
  }

  /**
   * 创建新模板
   */
  async createTemplate(template: Omit<CustomAnkiTemplate, 'id' | 'created_at' | 'updated_at'>): Promise<CustomAnkiTemplate> {
    const templateId = await templateManager.createTemplate(template);
    const created = await this.getTemplateById(templateId);
    if (!created) {
      throw new Error(`Template creation failed, id=${templateId}`);
    }
    return created;
  }

  /**
   * 更新模板
   */
  async updateTemplate(id: string, updates: Partial<CustomAnkiTemplate>): Promise<CustomAnkiTemplate> {
    const existing = await this.getTemplateById(id);
    if (!existing) {
      throw new Error(`Template with id ${id} not found`);
    }

    await templateManager.updateTemplate(id, updates);
    const updatedTemplate = await this.getTemplateById(id);
    if (!updatedTemplate) {
      throw new Error(`Template update failed, id=${id}`);
    }
    return updatedTemplate;
  }

  /**
   * 删除模板
   */
  async deleteTemplate(id: string): Promise<void> {
    const template = await this.getTemplateById(id);
    if (!template) {
      throw new Error(`Template with id ${id} not found`);
    }

    await templateManager.deleteTemplate(id);
  }

  /**
   * 设置默认模板
   */
  async setDefaultTemplate(id: string): Promise<void> {
    const template = await this.getTemplateById(id);
    if (!template) {
      throw new Error(`Template with id ${id} not found`);
    }

    await templateManager.setDefaultTemplate(id);
  }

  /**
   * 复制模板
   */
  async duplicateTemplate(id: string, nameSuffix?: string): Promise<CustomAnkiTemplate> {
    const original = await this.getTemplateById(id);
    if (!original) {
      throw new Error(`Template with id ${id} not found`);
    }

    const suffix = nameSuffix || ' - Copy';
    const duplicated = await this.createTemplate({
      ...original,
      name: original.name + suffix,
      author: 'Copied',
      is_built_in: false
    });

    return duplicated;
  }

  // ── 增强功能集成 ──

  /**
   * 分析模板复杂度
   */
  analyzeComplexity(template: CustomAnkiTemplate) {
    return TemplateComplexityAnalyzer.analyze(template);
  }

  /**
   * 生成增强提示词
   * 对所有模板都使用增强生成器，自动生成字段类型约束、JSON示例等
   */
  generatePrompt(template: CustomAnkiTemplate): string {
    // 确保模板有字段提取规则
    const rulesTemplate = this.ensureFieldExtractionRules(template);
    return EnhancedPromptGenerator.generatePrompt(rulesTemplate);
  }
  
  /**
   * 确保模板有字段提取规则
   * 如果没有，根据字段自动生成默认规则
   */
  public ensureFieldExtractionRules(template: CustomAnkiTemplate): CustomAnkiTemplate {
    const normalizeDefaultValue = (value: any) => {
      if (value === undefined || value === null) return '';
      return typeof value === 'string' ? value : JSON.stringify(value);
    };

    const existing = template.field_extraction_rules || {};
    const filled: Record<string, FieldExtractionRule> = {};

    // 先规范化已有规则，避免默认值类型错误
    Object.entries(existing).forEach(([field, rule]) => {
      filled[field] = {
        ...rule,
        default_value: normalizeDefaultValue((rule as any).default_value),
        description: rule.description || `${field}字段的内容`,
      };
    });

    // 防御性检查：确保 fields 是数组
    const fields = Array.isArray(template.fields) ? template.fields : [];
    fields.forEach(field => {
      if (!filled[field]) {
        const fieldLower = field.toLowerCase();
        filled[field] = {
          field_type: fieldLower === 'tags' ? 'Array' as any : 'Text' as any,
          is_required: fieldLower === 'front' || fieldLower === 'back',
          // 后端 FieldExtractionRule.default_value 为字符串，保持类型一致
          default_value: fieldLower === 'tags' ? '[]' : '',
          description: `${field}字段的内容`
        };
      }
    });

    return {
      ...template,
      field_extraction_rules: filled
    };
  }

  /**
   * 智能降级AI输出
   */
  downgradeAIOutput(aiOutput: any, template: CustomAnkiTemplate) {
    // 确保模板有字段提取规则
    const rulesTemplate = this.ensureFieldExtractionRules(template);
    return TemplateDowngrader.downgrade(rulesTemplate, aiOutput);
  }

  /**
   * 验证模板字段提取规则
   */
  validateFieldRules(fieldName: string, rule: FieldExtractionRule): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!rule.field_type) {
      errors.push(`Field type is required for ${fieldName}`);
    }

    if (!rule.description || !rule.description.trim()) {
      errors.push(`Description is required for ${fieldName}`);
    }

    // Removed Object and ArrayObject validation as these types are no longer supported for Anki

    // 验证规则合理性
    if (rule.validation) {
      const v = rule.validation;
      if (v.max && v.max < 0) {
        errors.push(`Invalid max value for ${fieldName}`);
      }
      if (v.min !== undefined && v.max !== undefined && v.min > v.max) {
        errors.push(`min cannot be greater than max for ${fieldName}`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  // ── 批量操作 ──

  /**
   * 批量更新模板状态
   */
  async batchUpdateStatus(templateIds: string[], active: boolean): Promise<void> {
    for (const id of templateIds) {
      await this.updateTemplate(id, { is_active: active });
    }
  }

  /**
   * 批量删除模板
   */
  async batchDelete(templateIds: string[]): Promise<{ success: string[]; failed: string[] }> {
    const success: string[] = [];
    const failed: string[] = [];

    for (const id of templateIds) {
      try {
        await this.deleteTemplate(id);
        success.push(id);
      } catch (error: unknown) {
        failed.push(id);
      }
    }

    return { success, failed };
  }

  // ── 搜索和筛选 ──

  /**
   * 搜索模板
   */
  async searchTemplates(query: string): Promise<CustomAnkiTemplate[]> {
    const templates = await this.getAllTemplates();
    const lowerQuery = query.toLowerCase();

    return templates.filter(template => 
      template.name.toLowerCase().includes(lowerQuery) ||
      template.description.toLowerCase().includes(lowerQuery) ||
      template.author.toLowerCase().includes(lowerQuery) ||
      template.fields.some(field => field.toLowerCase().includes(lowerQuery))
    );
  }

  /**
   * 按复杂度筛选模板
   */
  async filterByComplexity(level: 'simple' | 'moderate' | 'complex' | 'very_complex'): Promise<CustomAnkiTemplate[]> {
    const templates = await this.getAllTemplates();
    
    return templates.filter(template => {
      const complexity = this.analyzeComplexity(template);
      return complexity.level === level;
    });
  }

  /**
   * 获取模板统计信息
   */
  async getStatistics(): Promise<{
    total: number;
    builtin: number;
    custom: number;
    active: number;
    inactive: number;
    byComplexity: Record<string, number>;
  }> {
    const templates = await this.getAllTemplates();
    
    const stats = {
      total: templates.length,
      builtin: templates.filter(t => t.is_built_in).length,
      custom: templates.filter(t => !t.is_built_in).length,
      active: templates.filter(t => t.is_active).length,
      inactive: templates.filter(t => !t.is_active).length,
      byComplexity: { simple: 0, moderate: 0, complex: 0, very_complex: 0 }
    };

    for (const template of templates) {
      const complexity = this.analyzeComplexity(template);
      stats.byComplexity[complexity.level]++;
    }

    return stats;
  }

  // ── 导出和导入 ──

  /**
   * 导出模板为JSON
   */
  async exportTemplates(templateIds?: string[]): Promise<string> {
    let templates: CustomAnkiTemplate[];
    
    if (templateIds) {
      templates = [];
      for (const id of templateIds) {
        const template = await this.getTemplateById(id);
        if (template) templates.push(template);
      }
    } else {
      templates = await this.getAllTemplates();
    }

    return JSON.stringify(templates, null, 2);
  }

  /**
   * 导入模板从JSON
   */
  async importTemplates(jsonData: string): Promise<{ success: number; failed: number; errors: string[] }> {
    const result: { success: number; failed: number; errors: string[] } = { success: 0, failed: 0, errors: [] };

    try {
      const templates = JSON.parse(jsonData) as CustomAnkiTemplate[];

      for (const template of templates) {
        try {
          // 重新生成ID避免冲突
          await this.createTemplate({
            ...template,
            name: template.name + ' (Imported)',
            is_built_in: false
          });
          result.success++;
        } catch (error: unknown) {
          result.failed++;
          result.errors.push(`Failed to import ${template.name}: ${getErrorMessage(error)}`);
        }
      }
    } catch (error: unknown) {
      result.errors.push(`Invalid JSON format: ${getErrorMessage(error)}`);
    }

    return result;
  }
}

// 导出单例实例
export const templateService = TemplateService.getInstance();

// 导出便捷函数
export const initializeTemplateService = () => templateService.initialize();
export const getTemplate = (id: string) => templateService.getTemplateById(id);
export const getAllTemplates = () => templateService.getAllTemplates();
export const createTemplate = (template: Omit<CustomAnkiTemplate, 'id' | 'created_at' | 'updated_at'>) => 
  templateService.createTemplate(template);
export const updateTemplate = (id: string, updates: Partial<CustomAnkiTemplate>) => 
  templateService.updateTemplate(id, updates);
export const deleteTemplate = (id: string) => templateService.deleteTemplate(id);
export const analyzeTemplateComplexity = (template: CustomAnkiTemplate) => 
  templateService.analyzeComplexity(template);
export const generateTemplatePrompt = (template: CustomAnkiTemplate) => 
  templateService.generatePrompt(template);

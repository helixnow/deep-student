import {
  AnkiCardTemplate,
  CustomAnkiTemplate,
  FieldExtractionRule,
  FieldType,
  UpdateTemplateRequest
} from '../types';
import { sanitizeCSS, sanitizeHTML } from '../utils/templateValidation';
import i18n from '@/i18n';

// 模板数据已迁移到数据库，不再使用硬编码
// ⚠️ 已彻底移除旧的 _DEPRECATED_TEMPLATE_STRUCTURE 以避免误导和臃肿
// -----------------------------------------------------------------------------
// 统一模板管理类
export class TemplateManager {
  private customTemplates: CustomAnkiTemplate[] = [];
  private listeners: Array<(templates: CustomAnkiTemplate[]) => void> = [];
  private userDefaultTemplateId: string | null = null;

  constructor() {
    // 初始化时加载模板
    this.loadTemplates().catch(error => {
      console.error('Constructor loadTemplates failed:', error);
      // 强制重试一次
      setTimeout(() => this.loadTemplates(), 1000);
    });
  }

  // 从数据库加载所有模板
  async loadTemplates(): Promise<void> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');

      // 启动时按版本号同步内置模板：缺失则补齐，版本落后则覆盖更新
      try {
        await invoke('import_builtin_templates');
      } catch (syncErr) {
        console.warn('Failed to sync builtin templates by version:', syncErr);
      }

      // 并行加载所有模板和默认模板设置
      let [allTemplates, defaultTemplateId] = await Promise.all([
        invoke<CustomAnkiTemplate[]>('get_all_custom_templates'),
        invoke<string | null>('get_default_template_id').catch(() => null)
      ]);

      if (allTemplates.length === 0) {
        try {
          await invoke('import_builtin_templates');
          allTemplates = await invoke<CustomAnkiTemplate[]>('get_all_custom_templates');
          defaultTemplateId = await invoke<string | null>('get_default_template_id').catch(() => null);
        } catch (importErr) {
          console.warn('Failed to auto-import builtin templates:', importErr);
        }
      }

      // 注意：此处曾在启动时静默把模板 CSS 的 overflow:hidden 改写为 visible 并回写数据库，
      // 且共享的 /gi 正则配合 .test() 存在 lastIndex 状态残留，会随机漏判/误判模板。
      // 该逻辑已移除：溢出处理改为渲染时（非持久化）归一化，
      // 见 src/components/anki/utils/cardFaceStyles.ts 的 normalizeCssForRender。

      // 更新内存中的模板
      this.customTemplates = allTemplates;
      this.userDefaultTemplateId = defaultTemplateId;
      this.notifyListeners();

      console.log(`🎯 Loaded ${allTemplates.length} templates from database`);
    } catch (error) {
      console.error('Failed to load templates from database:', error);

      // 如果加载失败，使用最小的后备模板
      this.customTemplates = [this.createEmptyTemplate()];
      this.notifyListeners();
    }
  }

  // 获取所有模板
  getAllTemplates(): CustomAnkiTemplate[] {
    return this.customTemplates;
  }

  // 获取活跃模板
  getActiveTemplates(): CustomAnkiTemplate[] {
    return this.customTemplates.filter(t => t.is_active);
  }

  // 根据ID获取模板
  getTemplateById(id: string): CustomAnkiTemplate | undefined {
    return this.customTemplates.find(template => template.id === id);
  }

  // 获取默认模板
  getDefaultTemplate(): CustomAnkiTemplate {
    // 如果用户设置了默认模板，优先使用用户设置的
    if (this.userDefaultTemplateId) {
      const userDefault = this.customTemplates.find(t => t.id === this.userDefaultTemplateId);
      if (userDefault) {
        return userDefault;
      }
    }

    // 优先返回第一个内置模板
    const firstBuiltIn = this.customTemplates.find(t => t.is_built_in && t.is_active);
    if (firstBuiltIn) {
      return firstBuiltIn;
    }

    // 然后返回任何活跃的模板
    const firstActive = this.customTemplates.find(t => t.is_active);
    if (firstActive) {
      return firstActive;
    }

    // 最后返回第一个模板或创建空模板
    return this.customTemplates[0] || this.createEmptyTemplate();
  }

  // 创建一个空模板作为最后的后备
  private createEmptyTemplate(): CustomAnkiTemplate {
    return {
      id: 'empty-fallback',
      name: i18n.t('empty_template_name', { ns: 'template' }),
      description: i18n.t('fallback_template_desc', { ns: 'template' }),
      author: i18n.t('system_author', { ns: 'template' }),
      version: '1.0.0',
      preview_front: i18n.t('preview_front_default', { ns: 'template' }),
      preview_back: i18n.t('preview_back_default', { ns: 'template' }),
      note_type: 'Basic',
      fields: ['Front', 'Back'],
      generation_prompt: '',
      front_template: '<div>{{Front}}</div>',
      back_template: '<div>{{Front}}<hr>{{Back}}</div>',
      css_style: '.card { font-family: arial; font-size: 20px; text-align: center; }',
      field_extraction_rules: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      is_active: true,
      is_built_in: false,
    };
  }

  // 将CustomAnkiTemplate转换为AnkiCardTemplate（向后兼容）
  toAnkiCardTemplate(template: CustomAnkiTemplate): AnkiCardTemplate {
    return {
      id: template.id,
      name: template.name,
      description: template.description,
      preview_front: template.preview_front,
      preview_back: template.preview_back,
      preview_data_json: template.preview_data_json, // 包含预览数据
      front_template: template.front_template,
      back_template: template.back_template,
      css_style: template.css_style,
      note_type: template.note_type,
      generation_prompt: template.generation_prompt,
      fields: template.fields
    };
  }

  // 订阅模板变化
  subscribe(listener: (templates: CustomAnkiTemplate[]) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index > -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  private notifyListeners(): void {
    this.listeners.forEach(listener => listener(this.customTemplates));
  }

  private normalizeFieldType(value: unknown): FieldType {
    if (typeof value !== 'string') {
      return 'Text';
    }
    const normalized = value.trim().toLowerCase().replace(/[\s_-]/g, '');
    switch (normalized) {
      case 'text':
        return 'Text';
      case 'array':
        return 'Array';
      case 'number':
        return 'Number';
      case 'boolean':
        return 'Boolean';
      case 'date':
        return 'Date';
      case 'richtext':
        return 'RichText';
      case 'formula':
        return 'Formula';
      default:
        return 'Text';
    }
  }

  private normalizeDefaultValue(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private normalizeFieldExtractionRules(
    rules?: Record<string, FieldExtractionRule>
  ): Record<string, FieldExtractionRule> | undefined {
    if (!rules || typeof rules !== 'object') return undefined;
    const normalized: Record<string, FieldExtractionRule> = {};
    Object.entries(rules).forEach(([field, rule]) => {
      if (!rule || typeof rule !== 'object') return;
      const fieldType = this.normalizeFieldType((rule as FieldExtractionRule).field_type);
      const defaultValue = this.normalizeDefaultValue((rule as FieldExtractionRule).default_value);
      normalized[field] = {
        ...rule,
        field_type: fieldType,
        ...(defaultValue !== undefined ? { default_value: defaultValue } : {})
      };
    });
    return normalized;
  }

  private normalizeTemplatePayload(templateData: any): any {
    if (!templateData || typeof templateData !== 'object') {
      return templateData;
    }
    const normalizedRules = this.normalizeFieldExtractionRules(templateData.field_extraction_rules);
    return {
      ...templateData,
      front_template:
        typeof templateData.front_template === 'string'
          ? sanitizeHTML(templateData.front_template)
          : templateData.front_template,
      back_template:
        typeof templateData.back_template === 'string'
          ? sanitizeHTML(templateData.back_template)
          : templateData.back_template,
      css_style:
        typeof templateData.css_style === 'string'
          ? sanitizeCSS(templateData.css_style)
          : templateData.css_style,
      field_extraction_rules: normalizedRules ?? templateData.field_extraction_rules
    };
  }

  // 刷新模板列表
  async refresh(): Promise<void> {
    await this.loadTemplates();
  }

  // 创建新模板
  async createTemplate(templateData: any): Promise<string> {
    const { invoke } = await import('@tauri-apps/api/core');
    const normalizedTemplate = this.normalizeTemplatePayload(templateData);
    const templateId = await invoke<string>('create_custom_template', { request: normalizedTemplate });
    // 重新加载模板
    await this.loadTemplates();
    return templateId;
  }

  // 删除模板
  async deleteTemplate(templateId: string): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('delete_custom_template', { templateId });
    // 重新加载模板
    await this.loadTemplates();
  }

  // 更新模板
  async updateTemplate(templateId: string, templateData: any): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    const normalizedTemplate = this.normalizeTemplatePayload(templateData);
    let expectedVersion = normalizedTemplate?.version ?? this.getTemplateById(templateId)?.version;
    if (!expectedVersion) {
      await this.loadTemplates();
      expectedVersion = this.getTemplateById(templateId)?.version;
    }
    const { version, id, created_at, updated_at, ...rest } = normalizedTemplate ?? {};
    const request: UpdateTemplateRequest = {
      ...(rest || {}),
      expected_version: expectedVersion
    };
    await invoke('update_custom_template', { templateId, request });
    // 重新加载模板
    await this.loadTemplates();
  }

  // 加载用户默认模板设置
  async loadUserDefaultTemplate(): Promise<void> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      this.userDefaultTemplateId = await invoke<string | null>('get_default_template_id');
    } catch (error) {
      console.warn('Failed to load user default template:', error);
      this.userDefaultTemplateId = null;
    }
  }

  // 设置默认模板
  async setDefaultTemplate(templateId: string): Promise<void> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('set_default_template', { templateId });
      this.userDefaultTemplateId = templateId;
      this.notifyListeners(); // 通知UI更新
    } catch (error) {
      console.error('Failed to set default template:', error);
      throw error;
    }
  }

  // 获取当前默认模板ID
  getDefaultTemplateId(): string | null {
    return this.userDefaultTemplateId;
  }

  // 检查模板是否为默认模板
  isDefaultTemplate(templateId: string): boolean {
    return this.userDefaultTemplateId === templateId;
  }
}

// 全局模板管理器实例
export const templateManager = new TemplateManager();

// 兼容性函数
export const getTemplateById = (id: string): AnkiCardTemplate | undefined => {
  const template = templateManager.getTemplateById(id);
  return template ? templateManager.toAnkiCardTemplate(template) : undefined;
};

export const getDefaultTemplate = (): AnkiCardTemplate => {
  return templateManager.toAnkiCardTemplate(templateManager.getDefaultTemplate());
};

export const getTemplatePrompt = (templateId: string): string => {
  const template = templateManager.getTemplateById(templateId);
  return template?.generation_prompt || templateManager.getDefaultTemplate().generation_prompt;
};

export const getTemplateFields = (templateId: string): string[] => {
  const template = templateManager.getTemplateById(templateId);
  return template?.fields || ['Front', 'Back'];
};

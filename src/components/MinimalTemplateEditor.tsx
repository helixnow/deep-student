import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FileText, Code, Database, Settings, Eye, EyeOff,
  Plus, Trash2, AlertCircle, Copy
} from 'lucide-react';
import { CustomAnkiTemplate, CreateTemplateRequest, FieldExtractionRule } from '../types';
import { IframePreview, renderCardPreview } from './SharedPreview';
import { templateService } from '../services/templateService';
import { NotionButton } from '@/components/ui/NotionButton';
import { Input } from './ui/shad/Input';
import { Textarea } from './ui/shad/Textarea';
import { Label } from './ui/shad/Label';
import { Switch } from './ui/shad/Switch';
import { UnifiedCodeEditor } from './shared/UnifiedCodeEditor';
import './MinimalTemplateEditor.css';
import { useBreakpoint } from '@/hooks/useBreakpoint';

// 编辑器 Tab 类型导出
export type EditorTabType = 'basic' | 'templates' | 'styles' | 'data' | 'rules' | 'advanced';

interface MinimalTemplateEditorProps {
  template: CustomAnkiTemplate | null;
  mode: 'create' | 'edit';
  onSave: (templateData: CreateTemplateRequest) => Promise<void>;
  onCancel: () => void;
  // 外部控制的 tab（可选，如果提供则使用外部控制）
  externalActiveTab?: EditorTabType;
  onExternalTabChange?: (tab: EditorTabType) => void;
  // 是否隐藏内置侧边栏
  hideSidebar?: boolean;
}

interface ValidationError {
  field: string;
  message: string;
}

const MinimalTemplateEditor: React.FC<MinimalTemplateEditorProps> = ({
  template,
  mode,
  onSave,
  onCancel,
  externalActiveTab,
  onExternalTabChange,
  hideSidebar = false
}) => {
  const { t } = useTranslation('template');
  const { isSmallScreen } = useBreakpoint();

  // 基础数据
  const [formData, setFormData] = useState({
    name: template?.name || '',
    description: template?.description || '',
    author: template?.author || '',
    version: template?.version || '1.0.0',
    is_active: template?.is_active ?? true,
    preview_front: template?.preview_front || '',
    preview_back: template?.preview_back || '',
    note_type: template?.note_type || 'Basic',
    fields: template?.fields || ['Front', 'Back', 'Notes', 'Tags'],
    generation_prompt: template?.generation_prompt || '',
    front_template: template?.front_template || '<div class="card">{{Front}}</div>',
    back_template: template?.back_template || '<div class="card">{{Front}}<hr>{{Back}}</div>',
    css_style: template?.css_style || '.card { padding: 20px; background: white; border-radius: 8px; }'
  });

  // 预览数据JSON
  const [previewDataJson, setPreviewDataJson] = useState(() => {
    if (template?.preview_data_json) {
      try {
        return JSON.stringify(JSON.parse(template.preview_data_json), null, 2);
      } catch (e: unknown) {
        return '{}';
      }
    }
    return JSON.stringify({
      Front: t('example_question', '示例问题'),
      Back: t('example_answer', '示例答案'),
      Notes: t('example_notes', '补充说明'),
      Tags: [t('tag_1'), t('tag_2')]
    }, null, 2);
  });

  // 字段提取规则
  const [fieldExtractionRules, setFieldExtractionRules] = useState<Record<string, FieldExtractionRule>>(() => {
    if (template?.field_extraction_rules) {
      return template.field_extraction_rules;
    }
    
    // 默认规则
    const defaultRules: Record<string, FieldExtractionRule> = {};
    formData.fields.forEach(field => {
      defaultRules[field] = {
        field_type: field.toLowerCase() === 'tags' ? 'Array' : 'Text',
        is_required: field.toLowerCase() === 'front' || field.toLowerCase() === 'back',
        default_value: field.toLowerCase() === 'tags' ? '[]' : '',
        description: t('field_description', { field, defaultValue: `${field}字段的描述` })
      };
    });
    return defaultRules;
  });

  // UI状态 - 支持外部控制或内部状态
  const [internalActiveTab, setInternalActiveTab] = useState<EditorTabType>('basic');
  const activeTab = externalActiveTab ?? internalActiveTab;
  const setActiveTab = onExternalTabChange ?? setInternalActiveTab;
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>([]);
  const [previewMode, setPreviewMode] = useState<'front' | 'back'>('front');
  const [showPromptPreview, setShowPromptPreview] = useState(false);

  // 验证JSON
  const validateJson = (jsonString: string): boolean => {
    try {
      JSON.parse(jsonString);
      return true;
    } catch (e: unknown) {
      return false;
    }
  };

  // 验证表单
  const validateForm = (): ValidationError[] => {
    const errors: ValidationError[] = [];
    
    if (!formData.name.trim()) {
      errors.push({ field: 'name', message: t('template_name_empty') });
    }
    
    if (!formData.description.trim()) {
      errors.push({ field: 'description', message: t('description_empty') });
    }

    if (!formData.generation_prompt.trim()) {
      errors.push({
        field: 'generation_prompt',
        message: t('generation_prompt_required_error')
      });
    }
    
    if (formData.fields.length === 0) {
      errors.push({ field: 'fields', message: t('at_least_one_field', '至少需要一个字段') });
    }
    
    if (!validateJson(previewDataJson)) {
      errors.push({ field: 'preview_data_json', message: t('preview_data_invalid', '预览数据JSON格式无效') });
    }
    
    if (!formData.front_template.trim()) {
      errors.push({ field: 'front_template', message: t('front_template_empty') });
    }
    
    if (!formData.back_template.trim()) {
      errors.push({ field: 'back_template', message: t('back_template_empty') });
    }
 
    const missingRuleFields = formData.fields.filter(field => !fieldExtractionRules[field]);
    if (missingRuleFields.length > 0) {
      errors.push({
        field: 'field_rules',
        message: t('field_rules_missing', { fields: missingRuleFields.join(', ') })
      });
    }

    const extraRuleFields = Object.keys(fieldExtractionRules).filter(field => !formData.fields.includes(field));
    if (extraRuleFields.length > 0) {
      errors.push({
        field: 'field_rules',
        message: t('field_rules_extra', { fields: extraRuleFields.join(', ') })
      });
    }

    // 验证字段提取规则
    Object.entries(fieldExtractionRules).forEach(([fieldName, rule]) => {
      if (!rule.description || !rule.description.trim()) {
        errors.push({ field: 'field_rules', message: t('field_missing_description', { fieldName, defaultValue: `字段 ${fieldName} 缺少描述` }) });
      }
    });
    
    return errors;
  };

  // 处理字段变化
  const handleFieldsChange = (newFields: string[]) => {
    setFormData({ ...formData, fields: newFields });
    
    // 更新字段提取规则
    const newRules: Record<string, FieldExtractionRule> = {};
    newFields.forEach(field => {
      if (fieldExtractionRules[field]) {
        newRules[field] = fieldExtractionRules[field];
      } else {
        newRules[field] = {
          field_type: field.toLowerCase() === 'tags' ? 'Array' : 'Text',
          is_required: field.toLowerCase() === 'front' || field.toLowerCase() === 'back',
          default_value: field.toLowerCase() === 'tags' ? '[]' : '',
          description: t('field_description', { field, defaultValue: `${field}字段的描述` })
        };
      }
    });
    setFieldExtractionRules(newRules);
  };

  // 添加字段
  const addField = () => {
    const newFieldName = `Field${formData.fields.length + 1}`;
    handleFieldsChange([...formData.fields, newFieldName]);
  };

  // 删除字段
  const removeField = (index: number) => {
    const newFields = formData.fields.filter((_, i) => i !== index);
    handleFieldsChange(newFields);
  };

  // 更新字段名
  const updateFieldName = (index: number, newName: string) => {
    const oldName = formData.fields[index];
    const newFields = [...formData.fields];
    newFields[index] = newName;
    
    // 更新字段提取规则中的键名
    const newRules = { ...fieldExtractionRules };
    if (oldName !== newName && newRules[oldName]) {
      newRules[newName] = newRules[oldName];
      delete newRules[oldName];
    }
    
    setFormData({ ...formData, fields: newFields });
    setFieldExtractionRules(newRules);
  };

  // 增加版本号
  const incrementVersion = () => {
    const parts = formData.version.split('.');
    const patch = parseInt(parts[2] || '0', 10);
    parts[2] = (patch + 1).toString();
    setFormData({ ...formData, version: parts.join('.') });
  };

  // 提交表单
  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    
    const errors = validateForm();
    if (errors.length > 0) {
      setValidationErrors(errors);
      return;
    }
    
    setValidationErrors([]);
    setIsSubmitting(true);
    
    try {
      let parsedPreviewData;
      try {
        parsedPreviewData = JSON.parse(previewDataJson);
      } catch (e: unknown) {
        parsedPreviewData = {};
      }
      
      const templateData: CreateTemplateRequest = {
        ...formData,
        preview_data_json: previewDataJson,
        field_extraction_rules: fieldExtractionRules
      };
      
      await onSave(templateData);
    } catch (error: unknown) {
      console.error('Failed to save template:', error);
      setValidationErrors([{ field: 'general', message: error instanceof Error ? error.message : t('save_failed', '保存失败') }]);
    } finally {
      setIsSubmitting(false);
    }
  };

  // 复制JSON模板
  const copyJsonTemplate = () => {
    const template: Record<string, any> = {};
    formData.fields.forEach(field => {
      if (field.toLowerCase() === 'tags') {
        template[field] = [t('tag_1'), t('tag_2')];
      } else {
        template[field] = t('field_example_content', { field, defaultValue: `${field}的示例内容` });
      }
    });
    
    const jsonStr = JSON.stringify(template, null, 2);
    setPreviewDataJson(jsonStr);
    navigator.clipboard.writeText(jsonStr);
  };

  return (
    <div className={`minimal-template-editor ${hideSidebar ? 'no-sidebar' : ''}`}>
      {/* 侧边栏导航 - 可隐藏 */}
      {!hideSidebar && (
        <div className="editor-sidebar">
          <nav className="editor-nav">
            <button
              className={`nav-item ${activeTab === 'basic' ? 'active' : ''}`}
              onClick={() => setActiveTab('basic')}
            >
              <FileText size={18} />
              {t('basic_info')}
            </button>
            <button
              className={`nav-item ${activeTab === 'templates' ? 'active' : ''}`}
              onClick={() => setActiveTab('templates')}
            >
              <Code size={18} />
              {t('template_code', '模板代码')}
            </button>
            <button
              className={`nav-item ${activeTab === 'styles' ? 'active' : ''}`}
              onClick={() => setActiveTab('styles')}
            >
              <Code size={18} />
              {t('styles_design')}
            </button>
            <button
              className={`nav-item ${activeTab === 'data' ? 'active' : ''}`}
              onClick={() => setActiveTab('data')}
            >
              <Database size={18} />
              {t('preview_data', '预览数据')}
            </button>
            <button
              className={`nav-item ${activeTab === 'rules' ? 'active' : ''}`}
              onClick={() => setActiveTab('rules')}
            >
              <Settings size={18} />
              {t('extraction_rules')}
            </button>
            <button
              className={`nav-item ${activeTab === 'advanced' ? 'active' : ''}`}
              onClick={() => setActiveTab('advanced')}
            >
              <Settings size={18} />
              {t('advanced_settings', '高级设置')}
            </button>
          </nav>
        </div>
      )}

      {/* 主内容区 */}
      <div className="editor-main">
        {/* 内容区域 */}
        <div className="editor-content">
          {/* 错误提示 */}
          {validationErrors.length > 0 && (
            <div className="validation-alert">
              <AlertCircle size={16} />
              <div className="validation-messages">
                {validationErrors.map((error, index) => (
                  <div key={index} className="validation-message">
                    {error.message}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 基本信息 */}
          {activeTab === 'basic' && (
            <div className="setting-section">
              <div className="setting-section-header">
                <h2 className="setting-section-title">{t('basic_info')}</h2>
                <p className="setting-section-desc">{t('basic_info_desc')}</p>
              </div>
                <div className="form-grid">
                  <div className="form-field">
                    <Label className="field-label required">{t('template_name_label')}</Label>
                    <Input
                      type="text"
                      value={formData.name}
                      onChange={(e) => setFormData({...formData, name: e.target.value})}
                      placeholder={t('form_name_placeholder', '例如：编程代码卡片')}
                    />
                    <span className="field-hint">{t('template_name_hint')}</span>
                  </div>

                  <div className="form-field">
                    <Label className="field-label">{t('author')}</Label>
                    <Input
                      type="text"
                      value={formData.author}
                      onChange={(e) => setFormData({...formData, author: e.target.value})}
                      placeholder={t('form_author_placeholder', '您的名字')}
                    />
                  </div>

                  <div className="form-field">
                    <Label className="field-label">{t('version')}</Label>
                    <div className="flex gap-2">
                      <Input
                        type="text"
                        value={formData.version}
                        onChange={(e) => setFormData({...formData, version: e.target.value})}
                        placeholder="1.0.0"
                      />
                      {mode === 'edit' && (
                        <NotionButton
                          type="button"
                          variant="ghost"
                          size="sm"
                          iconOnly
                          onClick={incrementVersion}
                          title={t('increment_version') as string}
                        >
                          <Plus size={16} />
                        </NotionButton>
                      )}
                    </div>
                  </div>

                  <div className="form-field">
                    <Label className="field-label">{t('active_status')}</Label>
                    <div className="flex items-center gap-3">
                      <Switch
                        checked={formData.is_active}
                        onCheckedChange={(checked) => setFormData({...formData, is_active: checked})}
                      />
                      <span className="text-sm text-muted-foreground">
                        {formData.is_active ? t('active', '已激活') : t('inactive', '未激活')}
                      </span>
                    </div>
                  </div>

                  <div className="form-field full-width">
                    <Label className="field-label required">{t('form_description')}</Label>
                    <Textarea
                      value={formData.description}
                      onChange={(e) => setFormData({...formData, description: e.target.value})}
                      placeholder={t('form_description_placeholder', '描述模板的用途和特点')}
                      rows={3}
                    />
                  </div>

                  <div className="form-field">
                    <Label className="field-label">{t('form_note_type', '笔记类型')}</Label>
                    <Input
                      type="text"
                      value={formData.note_type}
                      onChange={(e) => setFormData({...formData, note_type: e.target.value})}
                      placeholder={t('note_type_placeholder', 'Basic')}
                    />
                  </div>

                  <div className="form-field">
                    <Label className="field-label required">{t('form_preview_front_required')}</Label>
                    <Input
                      type="text"
                      value={formData.preview_front}
                      onChange={(e) => setFormData({...formData, preview_front: e.target.value})}
                      placeholder={t('form_preview_front_placeholder') as string}
                    />
                  </div>

                  <div className="form-field">
                    <Label className="field-label required">{t('form_preview_back_required')}</Label>
                    <Input
                      type="text"
                      value={formData.preview_back}
                      onChange={(e) => setFormData({...formData, preview_back: e.target.value})}
                      placeholder={t('form_preview_back_placeholder') as string}
                    />
                  </div>
                </div>
            </div>
          )}

          {/* 字段管理 */}
          {activeTab === 'basic' && (
            <div className="setting-section">
              <div className="setting-section-header">
                <h2 className="setting-section-title">{t('field_management', '字段管理')}</h2>
                <p className="setting-section-desc">{t('field_management_desc', '定义卡片所需的字段')}</p>
              </div>
                <div className="fields-manager">
                  <div className="field-list">
                    {formData.fields.map((field, index) => (
                      <div key={index} className="field-item">
                        <Input
                          type="text"
                          value={field}
                          onChange={(e) => updateFieldName(index, e.target.value)}
                          placeholder={t('field_name_placeholder', '字段名称')}
                        />
                        <div className="field-item-actions">
                          <NotionButton
                            type="button"
                            variant="ghost"
                            size="sm"
                            iconOnly
                            onClick={() => removeField(index)}
                            disabled={formData.fields.length <= 1}
                            className="text-destructive hover:text-destructive"
                          >
                            <Trash2 size={16} />
                          </NotionButton>
                        </div>
                      </div>
                    ))}
                  </div>
                  <NotionButton
                    type="button"
                    variant="ghost"
                    onClick={addField}
                    className="mt-4"
                  >
                    <Plus size={16} className="mr-2" />
                    {t('add_field', '添加字段')}
                  </NotionButton>
                </div>
            </div>
          )}

          {/* 模板代码 */}
          {activeTab === 'templates' && (
            <>
              <div className="setting-section">
                <div className="setting-section-header">
                  <h2 className="setting-section-title">{t('front_template_title')}</h2>
                  <p className="setting-section-desc">{t('front_template_desc')}</p>
                </div>
                  <UnifiedCodeEditor
                    value={formData.front_template}
                    onChange={(value) => setFormData({...formData, front_template: value})}
                    language="html"
                    height="300px"
                    placeholder="{{Front}}"
                  />
              </div>

              <div className="setting-section">
                <div className="setting-section-header">
                  <h2 className="setting-section-title">{t('back_template_title')}</h2>
                  <p className="setting-section-desc">{t('back_template_desc')}</p>
                </div>
                  <UnifiedCodeEditor
                    value={formData.back_template}
                    onChange={(value) => setFormData({...formData, back_template: value})}
                    language="html"
                    height="300px"
                    placeholder="{{FrontSide}}<hr>{{Back}}"
                  />
              </div>

              {/* 预览 */}
              <div className="setting-section">
                <div className="setting-section-header flex items-center justify-between">
                  <div>
                    <h2 className="setting-section-title">{t('template_preview', '模板预览')}</h2>
                  </div>
                  <div className="flex gap-2">
                    <NotionButton
                      type="button"
                      variant={previewMode === 'front' ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setPreviewMode('front')}
                    >
                      {t('front_label', '正面')}
                    </NotionButton>
                    <NotionButton
                      type="button"
                      variant={previewMode === 'back' ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setPreviewMode('back')}
                    >
                      {t('back_label', '背面')}
                    </NotionButton>
                  </div>
                </div>
                  <div className="preview-section">
                    <div className="preview-content">
                      <IframePreview
                        htmlContent={renderCardPreview(
                          previewMode === 'front' ? formData.front_template : formData.back_template,
                          formData as any,
                          validateJson(previewDataJson) ? JSON.parse(previewDataJson) : {},
                          previewMode === 'back'
                        )}
                        cssContent={formData.css_style}
                      />
                    </div>
                  </div>
              </div>
            </>
          )}

          {/* 样式设计 */}
          {activeTab === 'styles' && (
            <div className="setting-section">
              <div className="setting-section-header">
                <h2 className="setting-section-title">{t('css_style_title')}</h2>
                <p className="setting-section-desc">{t('css_style_desc')}</p>
              </div>
                <UnifiedCodeEditor
                  value={formData.css_style}
                  onChange={(value) => setFormData({...formData, css_style: value})}
                  language="css"
                  height="500px"
                  placeholder=".card { ... }"
                />
            </div>
          )}

          {/* 预览数据 */}
          {activeTab === 'data' && (
            <div className="setting-section">
              <div className="setting-section-header">
                <h2 className="setting-section-title">{t('preview_data', '预览数据')}</h2>
                <p className="setting-section-desc">{t('preview_data_desc', '定义预览时使用的示例数据')}</p>
              </div>
                <div className="mb-3">
                  <NotionButton
                    type="button"
                    variant="ghost"
                    onClick={copyJsonTemplate}
                  >
                    <Copy size={16} className="mr-2" />
                    {t('generate_template_json', '生成模板JSON')}
                  </NotionButton>
                </div>
                <UnifiedCodeEditor
                  value={previewDataJson}
                  onChange={(value) => setPreviewDataJson(value)}
                  language="json"
                  height="400px"
                  placeholder="{}"
                />
                {!validateJson(previewDataJson) && (
                  <div className="text-destructive text-sm mt-2">
                    {t('json_invalid', 'JSON格式无效')}
                  </div>
                )}
            </div>
          )}

          {/* 提取规则 */}
          {activeTab === 'rules' && (
            <div className="setting-section">
              <div className="setting-section-header">
                <h2 className="setting-section-title">{t('field_extraction_rules')}</h2>
                <p className="setting-section-desc">{t('extraction_rules_desc', '定义AI如何提取和生成各个字段的内容')}</p>
              </div>
                <div className="rules-editor">
                  {Object.entries(fieldExtractionRules).map(([fieldName, rule]) => (
                    <div key={fieldName} className="mb-4 p-4 rounded-xl border border-border bg-muted/30">
                      <h3 className="text-base font-semibold mb-4">{fieldName}</h3>
                        <div className="grid grid-cols-3 gap-4">
                          <div className="form-field col-span-1">
                            <Label className="field-label">{t('field_type_label', '字段类型')}</Label>
                            <select
                              value={rule.field_type}
                              onChange={(e) => {
                                setFieldExtractionRules({
                                  ...fieldExtractionRules,
                                  [fieldName]: { ...rule, field_type: e.target.value as any }
                                });
                              }}
                              className="flex h-9 w-full rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--input))] px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                            >
                              <option value="Text">{t('field_type.text', '文本')}</option>
                              <option value="Integer">{t('field_type_option.integer', '整数')}</option>
                              <option value="Float">{t('field_type_option.float', '浮点数')}</option>
                              <option value="Boolean">{t('field_type.boolean', '布尔值')}</option>
                              <option value="Date">{t('field_type.date', '日期')}</option>
                              <option value="Array">{t('field_type.array', '数组')}</option>
                            </select>
                          </div>
                          
                          <div className="form-field col-span-2">
                            <Label className="field-label">{t('field_description_label', '字段描述')}</Label>
                            <Textarea
                              value={rule.description}
                              onChange={(e) => {
                                setFieldExtractionRules({
                                  ...fieldExtractionRules,
                                  [fieldName]: { ...rule, description: e.target.value }
                                });
                              }}
                              placeholder={t('field_purpose_placeholder', '描述这个字段的用途和内容要求')}
                              rows={2}
                            />
                          </div>
                          
                          <div className="form-field col-span-1">
                            <Label className="field-label">{t('is_required_label', '是否必填')}</Label>
                            <div className="flex items-center gap-3">
                              <Switch
                                checked={rule.is_required}
                                onCheckedChange={(checked) => {
                                  setFieldExtractionRules({
                                    ...fieldExtractionRules,
                                    [fieldName]: { ...rule, is_required: checked }
                                  });
                                }}
                              />
                              <span className="text-sm text-muted-foreground">
                                {rule.is_required ? t('required', '必填') : t('optional_label', '选填')}
                              </span>
                            </div>
                          </div>
                          
                          <div className="form-field col-span-2">
                            <Label className="field-label">{t('field_default_value', '默认值')}</Label>
                            <Input
                              type="text"
                              value={rule.default_value}
                              onChange={(e) => {
                                setFieldExtractionRules({
                                  ...fieldExtractionRules,
                                  [fieldName]: { ...rule, default_value: e.target.value }
                                });
                              }}
                              placeholder={rule.field_type === 'Array' ? '[]' : ''}
                            />
                          </div>
                        </div>
                    </div>
                  ))}
                </div>
            </div>
          )}

          {/* 高级设置 */}
          {activeTab === 'advanced' && (
            <>
              <div className="setting-section">
                <div className="setting-section-header">
                  <h2 className="setting-section-title">{t('advanced_settings', '高级设置')}</h2>
                  <p className="setting-section-desc">{t('advanced_settings_desc', '配置AI生成提示词和其他高级选项')}</p>
                </div>
                  <div className="form-field">
                    <div className="flex items-center justify-between mb-2">
                      <Label className="field-label">{t('core_requirements', '核心要求与说明')}</Label>
                      <NotionButton
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setShowPromptPreview(!showPromptPreview)}
                      >
                        {showPromptPreview ? <EyeOff size={16} className="mr-2" /> : <Eye size={16} className="mr-2" />}
                        {showPromptPreview ? t('hide', '隐藏') : t('preview', '预览')}{t('full_prompt', '完整提示词')}
                      </NotionButton>
                    </div>
                    <Textarea
                      value={formData.generation_prompt}
                      onChange={(e) => setFormData({...formData, generation_prompt: e.target.value})}
                      placeholder={t('generation_prompt_placeholder') as string}
                      rows={10}
                    />
                    <span className="field-hint">{t('generation_prompt_hint')}</span>
                  </div>
              </div>
              
              {/* 完整提示词预览 */}
              {showPromptPreview && (
                <div className="setting-section">
                  <div className="setting-section-header">
                    <h2 className="setting-section-title">{t('full_prompt_preview')}</h2>
                    <p className="setting-section-desc">{t('full_prompt_preview_desc')}</p>
                  </div>
                    <div className="preview-content font-mono text-sm bg-muted p-4 rounded-md">
                      {templateService.generatePrompt(formData as any)}
                    </div>
                </div>
              )}
            </>
          )}

          {/* 底部操作栏 - 参考设置页面风格 */}
          <div className="setting-section">
          <div className="flex items-center justify-between">
            <div className="footer-info">
              {mode === 'edit' && template && (
                <span className="text-sm text-muted-foreground">
                  {t('created_at_label', '创建于 {{date}}', { date: new Date(template.created_at).toLocaleDateString() })} · 
                  {t('updated_at_label', '更新于 {{date}}', { date: new Date(template.updated_at).toLocaleDateString() })}
                </span>
              )}
            </div>
            <div className="flex gap-3">
              <NotionButton type="button" variant="ghost" onClick={onCancel}>
                {t('cancel_button', '取消')}
              </NotionButton>
              <NotionButton
                type="button"
                onClick={handleSubmit}
                disabled={isSubmitting}
              >
                {isSubmitting && <div className="loading-spinner mr-2" />}
                {mode === 'create' ? t('submit_create', '创建模板') : t('submit_save', '保存更改')}
              </NotionButton>
            </div>
          </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MinimalTemplateEditor;

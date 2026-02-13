import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FileText, Code, Database, Settings, Eye, EyeOff,
  Plus, Trash2, AlertCircle, Check, X, Copy,
  ChevronDown, ChevronRight, Info, Shield
} from 'lucide-react';
import { CustomAnkiTemplate, CreateTemplateRequest, FieldExtractionRule, ValidationRule, TransformRule, ObjectSchema } from '../types';
import { IframePreview, renderCardPreview } from './SharedPreview';
import { templateService } from '../services/templateService';
import { UnifiedCodeEditor } from './shared/UnifiedCodeEditor';
import './MinimalTemplateEditor.css';

interface EnhancedTemplateEditorProps {
  template: CustomAnkiTemplate | null;
  mode: 'create' | 'edit';
  onSave: (templateData: CreateTemplateRequest) => Promise<void>;
  onCancel: () => void;
}

interface ValidationError {
  field: string;
  message: string;
}

const EnhancedTemplateEditor: React.FC<EnhancedTemplateEditorProps> = ({
  template,
  mode,
  onSave,
  onCancel
}) => {
  const { t } = useTranslation('template');
  
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

  // UI状态
  const [activeTab, setActiveTab] = useState<'basic' | 'templates' | 'styles' | 'data' | 'rules' | 'advanced'>('basic');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>([]);
  const [showPreviewDataHelp, setShowPreviewDataHelp] = useState(false);
  const [expandedRules, setExpandedRules] = useState<Set<string>>(new Set());
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
    
    if (formData.fields.length === 0) {
      errors.push({ field: 'fields', message: t('at_least_one_field') });
    }
    
    if (!validateJson(previewDataJson)) {
      errors.push({ field: 'preview_data_json', message: t('preview_data_invalid') });
    }
    
    if (!formData.front_template.trim()) {
      errors.push({ field: 'front_template', message: t('front_template_empty') });
    }
    
    if (!formData.back_template.trim()) {
      errors.push({ field: 'back_template', message: t('back_template_empty') });
    }
    
    // 验证字段提取规则
    Object.entries(fieldExtractionRules).forEach(([fieldName, rule]) => {
      if (!rule.description || !rule.description.trim()) {
        errors.push({ field: 'field_rules', message: t('field_missing_description', { fieldName, defaultValue: `字段 ${fieldName} 缺少描述` }) });
      }
      
      // Removed Object and ArrayObject validation as these types are no longer supported for Anki
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
    
    // 更新字段提取规则中的字段名
    const newRules = { ...fieldExtractionRules };
    if (newRules[oldName]) {
      newRules[newName] = { ...newRules[oldName] };
      delete newRules[oldName];
    }
    
    setFormData({ ...formData, fields: newFields });
    setFieldExtractionRules(newRules);
  };

  // 更新字段提取规则
  const updateFieldRule = (fieldName: string, updates: Partial<FieldExtractionRule>) => {
    setFieldExtractionRules({
      ...fieldExtractionRules,
      [fieldName]: {
        ...fieldExtractionRules[fieldName],
        ...updates
      }
    });
  };

  // 自动增加版本号
  const incrementVersion = () => {
    const parts = formData.version.split('.');
    const patch = parseInt(parts[2] || '0') + 1;
    const newVersion = `${parts[0] || '1'}.${parts[1] || '0'}.${patch}`;
    setFormData({ ...formData, version: newVersion });
  };

  // 提交表单
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // 验证
    const errors = validateForm();
    if (errors.length > 0) {
      setValidationErrors(errors);
      return;
    }
    
    setIsSubmitting(true);
    setValidationErrors([]);
    
    try {
      const templateData: CreateTemplateRequest = {
        name: formData.name,
        description: formData.description,
        author: formData.author || undefined,
        version: formData.version,
        is_active: formData.is_active,
        preview_front: formData.preview_front,
        preview_back: formData.preview_back,
        preview_data_json: previewDataJson,
        note_type: formData.note_type,
        fields: formData.fields,
        generation_prompt: formData.generation_prompt,
        front_template: formData.front_template,
        back_template: formData.back_template,
        css_style: formData.css_style,
        field_extraction_rules: fieldExtractionRules
      };

      await onSave(templateData);
    } catch (error: unknown) {
      console.error('保存模板失败:', error);
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
    <div className="minimal-template-editor">
      {/* 侧边栏导航 */}
      <div className="editor-sidebar">
        <div className="editor-logo">
          <h3>
            {t('template_editor', '模板编辑器')}
            <span className="editor-mode-badge">
              {mode === 'create' ? t('mode_create', '新建') : t('mode_edit', '编辑')}
            </span>
          </h3>
        </div>
        <nav className="editor-nav">
          <button
            className={`nav-item ${activeTab === 'basic' ? 'active' : ''}`}
            onClick={() => setActiveTab('basic')}
          >
            <FileText size={18} />
            {t('basic_info', '基本信息')}
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
            <Database size={18} />
            {t('styles_design', '样式设计')}
          </button>
          <button
            className={`nav-item ${activeTab === 'data' ? 'active' : ''}`}
            onClick={() => setActiveTab('data')}
          >
            <Database size={18} />
            {t('preview_data')}
          </button>
          <button
            className={`nav-item ${activeTab === 'rules' ? 'active' : ''}`}
            onClick={() => setActiveTab('rules')}
          >
            <Settings size={18} />
            {t('extraction_rules', '提取规则')}
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

      {/* 主内容区 */}
      <div className="editor-main">
        {/* 顶部栏 */}
        <div className="editor-topbar">
          <h4 className="topbar-title">
            {formData.name || t('unnamed_template', '未命名模板')}
            {template?.is_built_in && (
              <span className="builtin-badge">
                <Shield size={14} />
                {t('builtin_template_badge', '内置模板')}
              </span>
            )}
          </h4>
          <div className="topbar-actions">
            <button type="button" onClick={onCancel} className="btn btn-secondary">
              {t('cancel_button')}
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={isSubmitting}
              className="btn btn-primary"
            >
              {isSubmitting && <div className="loading-spinner" />}
              {mode === 'create' ? t('submit_create') : t('submit_save')}
            </button>
          </div>
        </div>

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
            <>
            <div className="content-card">
              <div className="card-header">
                <h3 className="card-title">{t('basic_info', '基本信息')}</h3>
                <p className="card-description">{t('basic_info_desc', '设置模板的基本属性和说明')}</p>
              </div>
              <div className="form-grid">
                <div className="form-field">
                  <label className="field-label required">{t('template_name_label', '模板名称')}</label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData({...formData, name: e.target.value})}
                    className="field-input"
                    placeholder={t('form_name_placeholder', '例如：编程代码卡片')}
                  />
                  <span className="field-hint">{t('template_name_hint', '给模板一个清晰的名称，方便查找和识别')}</span>
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">{t('author', '作者')}</label>
                <input
                  type="text"
                  value={formData.author}
                  onChange={(e) => setFormData({...formData, author: e.target.value})}
                  className="form-input"
                  placeholder={t('form_author_placeholder', '您的名字')}
                />
              </div>

              <div className="form-group">
                <label className="form-label">{t('version', '版本号')}</label>
                <div className="version-input">
                  <input
                    type="text"
                    value={formData.version}
                    onChange={(e) => setFormData({...formData, version: e.target.value})}
                    className="form-input"
                    placeholder="1.0.0"
                  />
                  {mode === 'edit' && (
                    <button
                      type="button"
                      onClick={incrementVersion}
                      className="version-increment"
                      title={t('increment_version', '增加版本号')}
                    >
                      <Plus size={16} />
                    </button>
                  )}
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">{t('active_status')}</label>
                <div className="toggle-wrapper">
                  <button
                    type="button"
                    onClick={() => setFormData({...formData, is_active: !formData.is_active})}
                    className={`toggle-button ${formData.is_active ? 'active' : ''}`}
                  >
                    {formData.is_active ? (
                      <>
                        <Check size={16} />
                        <span>{t('active')}</span>
                      </>
                    ) : (
                      <>
                        <X size={16} />
                        <span>{t('inactive')}</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              <div className="form-group full-width">
                <label className="form-label required">{t('form_description', '模板描述')}</label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({...formData, description: e.target.value})}
                  className="form-textarea"
                  rows={3}
                  placeholder={t('form_description_placeholder', '描述此模板的用途和特点')}
                />
              </div>

              <div className="form-group">
                <label className="form-label">{t('form_note_type', '笔记类型')}</label>
                <input
                  type="text"
                  value={formData.note_type}
                  onChange={(e) => setFormData({...formData, note_type: e.target.value})}
                  className="form-input"
                  placeholder={t('note_type_placeholder', 'Basic')}
                />
              </div>

              <div className="form-group">
                <label className="form-label required">{t('form_preview_front_required', '正面预览文本')}</label>
                <input
                  type="text"
                  value={formData.preview_front}
                  onChange={(e) => setFormData({...formData, preview_front: e.target.value})}
                  className="form-input"
                  placeholder={t('form_preview_front_placeholder', '卡片正面的预览内容')}
                />
              </div>

              <div className="form-group">
                <label className="form-label required">{t('form_preview_back_required', '背面预览文本')}</label>
                <input
                  type="text"
                  value={formData.preview_back}
                  onChange={(e) => setFormData({...formData, preview_back: e.target.value})}
                  className="form-input"
                  placeholder={t('form_preview_back_placeholder', '卡片背面的预览内容')}
                />
              </div>

              {/* 时间戳信息（只读） */}
              {mode === 'edit' && template && (
                <div className="form-group full-width">
                  <div className="timestamp-info">
                    <div>
                      <span className="label">{t('created_at_label', '创建于 {{date}}', { date: '' })}</span>
                      <span>{new Date(template.created_at).toLocaleString()}</span>
                    </div>
                    <div>
                      <span className="label">{t('updated_at_label', '更新于 {{date}}', { date: '' })}</span>
                      <span>{new Date(template.updated_at).toLocaleString()}</span>
                    </div>
                  </div>
                </div>
              )}
                {/* 结束基本信息卡片 */}
              </div>
              {/* 字段管理 */}
              <div className="fields-manager">
                <div className="section-header">
                  <h4>{t('field_management', '字段管理')}</h4>
                  <button
                    type="button"
                    onClick={addField}
                    className="btn-add-field"
                  >
                    <Plus size={16} />
                    {t('add_field', '添加字段')}
                  </button>
                </div>
                <div className="fields-list">
                  {formData.fields.map((field, index) => (
                    <div key={index} className="field-item">
                      <input
                        type="text"
                        value={field}
                        onChange={(e) => updateFieldName(index, e.target.value)}
                        className="field-input"
                      />
                      <button
                        type="button"
                        onClick={() => removeField(index)}
                        className="btn-remove-field"
                        disabled={formData.fields.length <= 1}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

        {/* 模板代码 */}
        {activeTab === 'templates' && (
          <div className="tab-content">
            <div className="templates-editor">
              <div className="template-section">
                <label className="form-label required">{t('front_template_title')}</label>
                <p className="section-hint">{t('front_template_desc', '使用 Mustache 语法编写卡片正面模板')}</p>
                <div className="template-editor-label">HTML + MUSTACHE</div>
                <div className="code-editor">
                  <UnifiedCodeEditor
                    value={formData.front_template}
                    onChange={(value) => setFormData({...formData, front_template: value})}
                    language="html"
                    height="200px"
                    placeholder='<div class="card">{{Front}}</div>'
                  />
                  <div className="code-help">
                    {t('use_mustache_hint', '使用 {{placeholder}} 来引用字段值', { placeholder: '{{字段名}}' })}
                  </div>
                </div>
              </div>

              <div className="template-section">
                <label className="form-label required">{t('back_template_title')}</label>
                <p className="section-hint">{t('back_template_desc', '使用 Mustache 语法编写卡片背面模板')}</p>
                <div className="template-editor-label">HTML + MUSTACHE</div>
                <div className="code-editor">
                  <UnifiedCodeEditor
                    value={formData.back_template}
                    onChange={(value) => setFormData({...formData, back_template: value})}
                    language="html"
                    height="200px"
                    placeholder='<div class="card">{{Front}}<hr>{{Back}}</div>'
                  />
                </div>
              </div>

              {/* 实时预览 */}
              <div className="template-preview">
                <div className="preview-header">
                  <h4>{t('live_preview', '实时预览')}</h4>
                  <div className="preview-toggle">
                    <button
                      type="button"
                      onClick={() => setPreviewMode('front')}
                      className={previewMode === 'front' ? 'active' : ''}
                    >
                      {t('front_label', '正面')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setPreviewMode('back')}
                      className={previewMode === 'back' ? 'active' : ''}
                    >
                      {t('back_label', '背面')}
                    </button>
                  </div>
                </div>
                <div className="preview-content">
                  <IframePreview
                    htmlContent={renderCardPreview(
                      previewMode === 'front' ? formData.front_template : formData.back_template,
                      {
                        ...template,
                        ...formData,
                        preview_data_json: previewDataJson
                      } as CustomAnkiTemplate,
                      undefined,
                      previewMode === 'back'
                    )}
                    cssContent={formData.css_style}
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 样式设计 */}
        {activeTab === 'styles' && (
          <div className="tab-content">
            <div className="styles-editor">
              <label className="form-label">{t('css_style_title')}</label>
              <p className="section-hint">{t('css_style_desc', '自定义卡片的视觉样式')}</p>
              <div className="template-editor-label">CSS</div>
              <div className="code-editor">
                <UnifiedCodeEditor
                  value={formData.css_style}
                  onChange={(value) => setFormData({...formData, css_style: value})}
                  language="css"
                  height="400px"
                  placeholder=".card { padding: 20px; }"
                />
                <div className="code-help">
                  {t('css_style_hint', '定义卡片的样式，支持所有CSS特性')}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 预览数据 */}
        {activeTab === 'data' && (
          <div className="tab-content">
            <div className="preview-data-editor">
              <div className="section-header">
                <label className="form-label">{t('preview_data_label')}</label>
                <div className="header-actions">
                  <button
                    type="button"
                    onClick={() => setShowPreviewDataHelp(!showPreviewDataHelp)}
                    className="btn-help"
                  >
                    <Info size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={copyJsonTemplate}
                    className="btn-copy"
                  >
                    <Copy size={16} />
                    {t('generate_template', '生成模板')}
                  </button>
                </div>
              </div>

              {showPreviewDataHelp && (
                <div className="help-content">
                  <p>{t('preview_data_usage')}</p>
                  <p>{t('json_format_hint')}</p>
                  <p>{t('click_generate_json')}</p>
                </div>
              )}

              <div className="json-editor">
                <div className="template-editor-label">JSON</div>
                <UnifiedCodeEditor
                  value={previewDataJson}
                  onChange={(value) => setPreviewDataJson(value)}
                  language="json"
                  height="300px"
                  placeholder='{}'
                  className={!validateJson(previewDataJson) ? 'json-invalid' : ''}
                />
                {!validateJson(previewDataJson) && (
                  <div className="json-error">
                    <AlertCircle size={14} />
                    {t('json_invalid')}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* 提取规则 */}
        {activeTab === 'rules' && (
          <div className="tab-content">
            <div className="extraction-rules-editor">
              <div className="section-header">
                <h4>{t('field_extraction_rules', '字段提取规则')}</h4>
                <div className="help-text">
                  {t('extraction_rules_desc', '定义如何从用户输入中提取各个字段的值')}
                </div>
              </div>

              <div className="rules-list">
                {Object.entries(fieldExtractionRules).map(([fieldName, rule]) => (
                  <div key={fieldName} className="rule-item">
                    <div 
                      className="rule-header"
                      onClick={() => {
                        const newExpanded = new Set(expandedRules);
                        if (newExpanded.has(fieldName)) {
                          newExpanded.delete(fieldName);
                        } else {
                          newExpanded.add(fieldName);
                        }
                        setExpandedRules(newExpanded);
                      }}
                    >
                      <div className="rule-title">
                        {expandedRules.has(fieldName) ? (
                          <ChevronDown size={16} />
                        ) : (
                          <ChevronRight size={16} />
                        )}
                        <span className="field-name">{fieldName}</span>
                        <span className={`field-type ${rule.field_type.toLowerCase()}`}>
                          {rule.field_type}
                        </span>
                        {rule.is_required && (
                          <span className="required-badge">{t('required', '必填')}</span>
                        )}
                      </div>
                    </div>

                    {expandedRules.has(fieldName) && (
                      <div className="rule-content">
                        <div className="rule-form">
                          <div className="form-row">
                            <label>{t('field_type_label', '字段类型')}</label>
                            <select
                              value={rule.field_type}
                              onChange={(e) => updateFieldRule(fieldName, { 
                                field_type: e.target.value as 'Text' | 'Number' | 'Array' | 'Boolean' | 'Date' | 'RichText' | 'Formula'
                              })}
                              className="form-select"
                            >
                              <option value="Text">{t('field_type.text', '文本')}</option>
                              <option value="Number">{t('field_type.number', '数字')}</option>
                              <option value="Array">{t('field_type.array', '数组')}</option>
                              <option value="Boolean">{t('field_type.boolean', '布尔值')}</option>
                              <option value="Date">{t('field_type.date', '日期时间')}</option>
                              <option value="RichText">{t('field_type.rich_text', '富文本')}</option>
                              <option value="Formula">{t('field_type.formula', '公式')}</option>
                            </select>
                          </div>

                          <div className="form-row">
                            <label>
                              <input
                                type="checkbox"
                                checked={rule.is_required}
                                onChange={(e) => updateFieldRule(fieldName, { 
                                  is_required: e.target.checked 
                                })}
                              />
                              {t('field_required', '必填字段')}
                            </label>
                          </div>

                          <div className="form-row">
                            <label>{t('field_default_value', '默认值')}</label>
                            <input
                              type="text"
                              value={rule.default_value}
                              onChange={(e) => updateFieldRule(fieldName, { 
                                default_value: e.target.value 
                              })}
                              className="form-input"
                              placeholder={rule.field_type === 'Array' ? '[]' : ''}
                            />
                          </div>

                          <div className="form-row">
                            <label>{t('field_description_label', '字段描述')}</label>
                            <textarea
                              value={rule.description}
                              onChange={(e) => updateFieldRule(fieldName, { 
                                description: e.target.value 
                              })}
                              className="form-textarea"
                              rows={2}
                              placeholder={t('field_purpose_placeholder', '描述此字段的用途')}
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* 高级设置 */}
        {activeTab === 'advanced' && (
          <div className="tab-content">
            <div className="advanced-settings">
              <div className="form-group">
                <div className="section-header">
                  <label className="form-label">{t('core_requirements')}</label>
                  <button
                    type="button"
                    onClick={() => setShowPromptPreview(!showPromptPreview)}
                    className="btn-preview"
                  >
                    {showPromptPreview ? <EyeOff size={16} /> : <Eye size={16} />}
                    {showPromptPreview ? t('hide') : t('preview')}{t('full_prompt')}
                  </button>
                </div>
                <textarea
                  value={formData.generation_prompt}
                  onChange={(e) => setFormData({...formData, generation_prompt: e.target.value})}
                  className="form-textarea"
                  rows={10}
                  placeholder={t('core_requirements_placeholder') as string}
                />
                <div className="form-help">
                  <strong>{t('prompt_hint')}</strong>{t('auto_generate_desc')}
                  <ul style={{ marginTop: '8px', marginBottom: 0, paddingLeft: '20px' }}>
                    <li>{t('auto_field_constraints')}</li>
                    <li>{t('auto_json_example')}</li>
                    <li>{t('auto_error_reminders')}</li>
                    <li>{t('auto_best_practices')}</li>
                  </ul>
                </div>
              </div>

              {/* 完整提示词预览 */}
              {showPromptPreview && (
                <div className="prompt-preview">
                  <h4>{t('full_prompt_preview_title')}</h4>
                  <div className="preview-content">
                    <pre>{(() => {
                      try {
                        // 构建临时模板对象来生成预览
                        const tempTemplate: CustomAnkiTemplate = {
                          ...template,
                          ...formData,
                          field_extraction_rules: fieldExtractionRules,
                          preview_data_json: previewDataJson
                        } as CustomAnkiTemplate;
                        return templateService.generatePrompt(tempTemplate);
                      } catch (error: unknown) {
                        return t('preview_generation_failed', '预览生成失败：{{error}}', { error: error instanceof Error ? error.message : String(error) });
                      }
                    })()}</pre>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

          {/* 操作按钮 */}
          <div className="editor-actions">
            <button 
              type="submit" 
              disabled={isSubmitting}
              className="btn-primary"
            >
              {isSubmitting ? t('submit_creating') : (mode === 'create' ? t('submit_create') : t('submit_save'))}
            </button>
            <button 
              type="button" 
              onClick={onCancel}
              className="btn-secondary"
            >
              {t('cancel_button')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default EnhancedTemplateEditor;

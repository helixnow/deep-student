import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { CustomAnkiTemplate } from '../../types';
import { IframePreview } from '../SharedPreview';
import { UnifiedCodeEditor, CodeLanguage } from '../shared/UnifiedCodeEditor';
import { useTranslation } from 'react-i18next';
import Mustache from 'mustache';
import { debounce } from '../../utils/common';
import { ValidationError } from './template.worker';
import { CheckCircle, AlertTriangle, X, Save, Eye, Code, Palette } from 'lucide-react';
import './RealTimeTemplateEditor.css';
import { unifiedAlert, unifiedConfirm } from '@/utils/unifiedDialogs';

// 创建Worker实例
let templateWorker: Worker | null = null;
if (typeof Worker !== 'undefined') {
  try {
    templateWorker = new Worker(
      new URL('./template.worker.ts', import.meta.url),
      { type: 'module' }
    );
  } catch (error) {
    console.warn('Failed to create Web Worker, falling back to main thread processing');
  }
}

interface RealTimeTemplateEditorProps {
  template: CustomAnkiTemplate;
  onSave: (template: CustomAnkiTemplate) => Promise<void>;
  onCancel: () => void;
}

export const RealTimeTemplateEditor: React.FC<RealTimeTemplateEditorProps> = ({
  template,
  onSave,
  onCancel
}) => {
  const { t } = useTranslation('template');
  
  // 状态管理
  const [editingTemplate, setEditingTemplate] = useState<CustomAnkiTemplate>(template);
  const [activeTab, setActiveTab] = useState<'front' | 'back' | 'css'>('front');
  const [previewSide, setPreviewSide] = useState<'front' | 'back' | 'both'>('both');
  const [errors, setErrors] = useState<Map<string, ValidationError[]>>(new Map());
  const [isCompiling, setIsCompiling] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  
  // 预览数据
  const [previewData, setPreviewData] = useState({
    Front: t('preview_sample_front'),
    Back: t('preview_sample_back'),
    Notes: t('preview_sample_notes'),
    Tags: ['AI', 'ML', 'Basics'],
    Example: 'const model = await tf.sequential({...});',
    Source: t('preview_sample_source')
  });

  // 渲染缓存
  const renderCache = useRef<Map<string, string>>(new Map());
  const lastRenderRequest = useRef<number>(0);

  // 防抖编译函数
  const compileTemplate = useMemo(
    () => debounce((template: CustomAnkiTemplate, requestId: number) => {
      if (requestId < lastRenderRequest.current) return;
      
      setIsCompiling(true);
      
      if (templateWorker) {
        templateWorker.postMessage({
          type: 'compile',
          template,
          previewData,
          requestId
        });
      } else {
        // 降级到主线程处理
        try {
          const rendered = {
            front: Mustache.render(template.front_template, previewData),
            back: Mustache.render(template.back_template, previewData)
          };
          renderCache.current = new Map(Object.entries(rendered));
          setIsCompiling(false);
        } catch (error) {
          console.error('Template compilation error:', error);
          setIsCompiling(false);
        }
      }
    }, 150),
    [previewData]
  );

  // 处理Worker消息
  useEffect(() => {
    if (!templateWorker) return;
    
    const handleWorkerMessage = (event: MessageEvent) => {
      const { type, data, requestId } = event.data;
      
      if (requestId < lastRenderRequest.current) return;
      
      switch (type) {
        case 'compiled':
          renderCache.current = new Map(Object.entries(data.rendered));
          setErrors(new Map(Object.entries(data.errors)));
          setIsCompiling(false);
          break;
          
        case 'error':
          console.error('Template compilation error:', data);
          setIsCompiling(false);
          break;
      }
    };

    templateWorker.addEventListener('message', handleWorkerMessage);
    return () => templateWorker?.removeEventListener('message', handleWorkerMessage);
  }, []);

  // 处理模板变更
  const handleTemplateChange = useCallback((field: keyof CustomAnkiTemplate, value: string) => {
    const updated = { ...editingTemplate, [field]: value };
    setEditingTemplate(updated);
    setIsDirty(true);
    
    // 触发编译
    const requestId = ++lastRenderRequest.current;
    compileTemplate(updated, requestId);
  }, [editingTemplate, compileTemplate]);

  // 获取渲染后的HTML
  const getRenderedHtml = useCallback((side: 'front' | 'back') => {
    const cached = renderCache.current.get(side);
    if (cached) return cached;
    
    // 降级到同步渲染
    try {
      const template = side === 'front' ? editingTemplate.front_template : editingTemplate.back_template;
      return Mustache.render(template, previewData);
    } catch (error: any) {
      return `<div class="render-error">${t('render_error')}: ${error.message}</div>`;
    }
  }, [editingTemplate, previewData]);

  // 保存处理
  const handleSave = async () => {
    // 验证是否有阻塞性错误
    const hasBlockingErrors = Array.from(errors.values())
      .flat()
      .some(error => error.severity === 'error');
    
    if (hasBlockingErrors) {
    const confirmed = await Promise.resolve(unifiedConfirm(t('save_with_errors_confirm')));
    if (!confirmed) {
        return;
      }
    }
    
    setIsSaving(true);
    try {
      await onSave(editingTemplate);
      setIsDirty(false);
    } catch (error) {
      console.error('Save failed:', error);
      unifiedAlert(t('save_failed'));
    } finally {
      setIsSaving(false);
    }
  };

  // 快捷键支持
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        handleSave();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [editingTemplate]);

  // 初始编译
  useEffect(() => {
    const requestId = ++lastRenderRequest.current;
    compileTemplate(editingTemplate, requestId);
  }, []);

  return (
    <div className="realtime-template-editor">
      {/* 头部工具栏 */}
      <div className="editor-toolbar">
        <div className="toolbar-left">
          <h3>{editingTemplate.name}</h3>
          {isDirty && <span className="dirty-indicator">• {t('unsaved')}</span>}
        </div>
        
        <div className="toolbar-center">
          <div className="view-mode-selector">
            <NotionButton variant="ghost" size="sm" className={previewSide === 'front' ? 'active' : ''} onClick={() => setPreviewSide('front')} title={t('preview_front')}>
              {t('front')}
            </NotionButton>
            <NotionButton variant="ghost" size="sm" className={previewSide === 'back' ? 'active' : ''} onClick={() => setPreviewSide('back')} title={t('preview_back')}>
              {t('back')}
            </NotionButton>
            <NotionButton variant="ghost" size="sm" className={previewSide === 'both' ? 'active' : ''} onClick={() => setPreviewSide('both')} title={t('preview_both')}>
              {t('both')}
            </NotionButton>
          </div>
        </div>
        
        <div className="toolbar-right">
          <NotionButton variant="default" size="sm" className="btn-secondary" onClick={onCancel} disabled={isSaving} title={t('cancel_edit')}>
            <X size={16} />
            {t('cancel')}
          </NotionButton>
          <NotionButton variant="primary" size="sm" className="btn-primary" onClick={handleSave} disabled={isSaving} title={t('save_template')}>
            <Save size={16} />
            {t('save')} {isDirty && '*'}
          </NotionButton>
        </div>
      </div>

      {/* 主编辑区 */}
      <div className="editor-main">
        {/* 左侧：代码编辑器 */}
        <div className="editor-panel">
          <div className="editor-tabs">
            <NotionButton variant="ghost" size="sm" className={`tab ${activeTab === 'front' ? 'active' : ''}`} onClick={() => setActiveTab('front')}>
              <Code size={16} />
              {t('front_template')}
              {errors.get('front')?.length > 0 && (
                <span className="error-badge">{errors.get('front')!.length}</span>
              )}
            </NotionButton>
            <NotionButton variant="ghost" size="sm" className={`tab ${activeTab === 'back' ? 'active' : ''}`} onClick={() => setActiveTab('back')}>
              <Code size={16} />
              {t('back_template')}
              {errors.get('back')?.length > 0 && (
                <span className="error-badge">{errors.get('back')!.length}</span>
              )}
            </NotionButton>
            <NotionButton variant="ghost" size="sm" className={`tab ${activeTab === 'css' ? 'active' : ''}`} onClick={() => setActiveTab('css')}>
              <Palette size={16} />
              {t('style')}
              {errors.get('css')?.length > 0 && (
                <span className="error-badge">{errors.get('css')!.length}</span>
              )}
            </NotionButton>
          </div>

          <div className="code-editor-container">
            {activeTab === 'front' && (
              <TemplateCodeEditor
                value={editingTemplate.front_template}
                onChange={(value) => handleTemplateChange('front_template', value)}
                language="html"
                errors={errors.get('front') || []}
              />
            )}
            {activeTab === 'back' && (
              <TemplateCodeEditor
                value={editingTemplate.back_template}
                onChange={(value) => handleTemplateChange('back_template', value)}
                language="html"
                errors={errors.get('back') || []}
              />
            )}
            {activeTab === 'css' && (
              <TemplateCodeEditor
                value={editingTemplate.css_style}
                onChange={(value) => handleTemplateChange('css_style', value)}
                language="css"
                errors={errors.get('css') || []}
              />
            )}
          </div>

          {/* 错误面板 */}
          <ErrorPanel errors={errors.get(activeTab) || []} />
        </div>

        {/* 右侧：实时预览 */}
        <div className="preview-panel">
          <div className="preview-header">
            <h4>
              <Eye size={16} />
              {t('real_time_preview')}
            </h4>
            {isCompiling && <span className="compiling-indicator">{t('compiling')}...</span>}
          </div>

          {/* 预览数据编辑器 */}
          <PreviewDataEditor
            data={previewData}
            onChange={setPreviewData}
            fields={editingTemplate.fields}
          />

          {/* 卡片预览 */}
          <div className="card-previews">
            {(previewSide === 'front' || previewSide === 'both') && (
              <div className="preview-card">
                <h5>{t('front_preview')}</h5>
                <IframePreview
                  htmlContent={getRenderedHtml('front')}
                  cssContent={editingTemplate.css_style}
                />
              </div>
            )}
            
            {(previewSide === 'back' || previewSide === 'both') && (
              <div className="preview-card">
                <h5>{t('back_preview')}</h5>
                <IframePreview
                  htmlContent={getRenderedHtml('back')}
                  cssContent={editingTemplate.css_style}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// 代码编辑器组件 - 使用统一的 UnifiedCodeEditor
interface TemplateCodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language: string;
  errors: ValidationError[];
}

const TemplateCodeEditor: React.FC<TemplateCodeEditorProps> = ({
  value,
  onChange,
  language,
  errors
}) => {
  // 将 language 字符串映射为 CodeLanguage 类型
  const codeLanguage: CodeLanguage = language === 'css' ? 'css' : 'html';

  return (
    <UnifiedCodeEditor
      value={value}
      onChange={onChange}
      language={codeLanguage}
      height="100%"
      lineNumbers={true}
      foldGutter={true}
      highlightActiveLine={true}
      className="h-full"
    />
  );
};

// 预览数据编辑器
interface PreviewDataEditorProps {
  data: Record<string, any>;
  onChange: (data: Record<string, any>) => void;
  fields: string[];
}

const PreviewDataEditor: React.FC<PreviewDataEditorProps> = ({ data, onChange, fields }) => {
  const { t } = useTranslation('template');
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className={`preview-data-editor ${isExpanded ? 'expanded' : ''}`}>
      <div className="editor-header" onClick={() => setIsExpanded(!isExpanded)}>
        <span>{t('preview_data')}</span>
        <span className="toggle-icon">{isExpanded ? '▼' : '▶'}</span>
      </div>
      
      {isExpanded && (
        <div className="editor-fields">
          {fields.map(field => (
            <div key={field} className="field-editor">
              <label>{field}:</label>
              {Array.isArray(data[field]) ? (
                <input
                  type="text"
                  value={data[field].join(', ')}
                  onChange={(e) => onChange({
                    ...data,
                    [field]: e.target.value.split(',').map(s => s.trim())
                  })}
                  placeholder={t('enter_values')}
                />
              ) : (
                <input
                  type="text"
                  value={data[field] || ''}
                  onChange={(e) => onChange({
                    ...data,
                    [field]: e.target.value
                  })}
                  placeholder={t('enter_value')}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// 错误面板
const ErrorPanel: React.FC<{ errors: ValidationError[] }> = ({ errors }) => {
  const { t } = useTranslation('template');
  
  if (errors.length === 0) {
    return (
      <div className="error-panel no-errors">
        <CheckCircle size={16} />
        <span>{t('no_errors')}</span>
      </div>
    );
  }

  return (
    <div className="error-panel">
      {errors.map((error, index) => (
        <div key={index} className={`error-item ${error.severity}`}>
          <span className="error-icon">
            {error.severity === 'error' ? (
              <X size={16} />
            ) : (
              <AlertTriangle size={16} />
            )}
          </span>
          <div className="error-content">
            <div className="error-message">{error.message}</div>
            {error.line && (
              <div className="error-location">
                {t('line')} {error.line}, {t('column')} {error.column || 0}
              </div>
            )}
            {error.suggestion && (
              <div className="error-suggestion">💡 {error.suggestion}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};

export default RealTimeTemplateEditor;

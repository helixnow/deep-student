import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  FileText, Code, Database, Gear, Eye, EyeSlash,
  WarningCircle, Copy, Info
} from '@phosphor-icons/react';
import {
  CustomAnkiTemplate, CreateTemplateRequest, FieldExtractionRule,
  FieldType,
} from '../types';
import { TemplateRenderService } from '../services/templateRenderService';
import type { TemplateRenderIssue } from '../services/ankiTemplateEngine';
import { templateService } from '../services/templateService';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from './ui/shad/Input';
import { Textarea } from './ui/shad/Textarea';
import { Label } from './ui/shad/Label';
import { Switch } from './ui/shad/Switch';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './ui/shad/Select';
import { UnifiedCodeEditor } from './shared/UnifiedCodeEditor';
import CodeMirror, { ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { html } from '@codemirror/lang-html';
import { css as cssLang } from '@codemirror/lang-css';
import { EditorView } from '@codemirror/view';
import { vscodeDark, vscodeLight } from '@uiw/codemirror-theme-vscode';
import { HorizontalResizable } from './shared/Resizable';
import { CodeMirrorScrollOverlay } from './skills-management/CodeMirrorScrollOverlay';
import { CustomScrollArea } from './custom-scroll-area';
import { TemplateEditorInsertBar } from './TemplateEditorInsertBar';
import { TemplateEditorPreviewPanel, TemplatePreviewSide } from './TemplateEditorPreviewPanel';
import { TemplateEditorFieldManager, FieldRenameResult } from './TemplateEditorFieldManager';
import { lintTemplate, extractFieldReferences, renameFieldReferences } from './TemplateEditorLint';
import './MinimalTemplateEditor.css';
import './TemplateEditorEnhancements.css';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { useDebounce } from '@/hooks/useDebounce';

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
  // 移动端：编辑器 portal 目标容器（由 MobileSlidingLayout 的 rightPanel 提供）
  mobileEditorPortalTarget?: HTMLDivElement | null;
  /** 可选：未保存更改状态变化回调（供外层做离开确认等） */
  onDirtyChange?: (dirty: boolean) => void;
}

interface ValidationError {
  field: string;
  message: string;
}

/** 字段类型选项（与 FieldType 联合类型保持一致，收紧原 as any 写法） */
const FIELD_TYPE_OPTIONS: FieldType[] = ['Text', 'Number', 'Boolean', 'Date', 'Array', 'RichText', 'Formula'];
const isFieldType = (value: string): value is FieldType =>
  (FIELD_TYPE_OPTIONS as string[]).includes(value);

/**
 * 笔记类型下拉选项：与前端校验（templateValidation.validateTemplate 的 validNoteTypes）
 * 保持同一枚举；后端不强制枚举，但 Cloze 会触发 {{cloze:}} 占位符校验。
 */
const NOTE_TYPE_OPTIONS = [
  'Basic',
  'Cloze',
  'Basic (and reversed card)',
  'Basic (optional reversed card)',
];

/** 检测模板 HTML 中是否含 <script>（用于信息级提示，不做剥除） */
const containsScriptTag = (html: string) => /<script[\s>]/i.test(html);

const MinimalTemplateEditor: React.FC<MinimalTemplateEditorProps> = ({
  template,
  mode,
  onSave,
  onCancel,
  externalActiveTab,
  onExternalTabChange,
  hideSidebar = false,
  mobileEditorPortalTarget,
  onDirtyChange,
}) => {
  const { t } = useTranslation('template');
  const { t: tAnki } = useTranslation('anki');
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
      Front: t('example_question'),
      Back: t('example_answer'),
      Notes: t('example_notes'),
      Tags: [t('tag_1'), t('tag_2')]
    }, null, 2);
  });

  // 字段默认提取规则
  const buildDefaultRule = useCallback((field: string): FieldExtractionRule => ({
    field_type: field.toLowerCase() === 'tags' ? 'Array' : 'Text',
    is_required: field.toLowerCase() === 'front' || field.toLowerCase() === 'back',
    default_value: field.toLowerCase() === 'tags' ? '[]' : '',
    description: t('field_description', { field })
  }), [t]);

  // 字段提取规则
  const [fieldExtractionRules, setFieldExtractionRules] = useState<Record<string, FieldExtractionRule>>(() => {
    if (template?.field_extraction_rules) {
      return template.field_extraction_rules;
    }
    const defaultRules: Record<string, FieldExtractionRule> = {};
    formData.fields.forEach(field => {
      defaultRules[field] = buildDefaultRule(field);
    });
    return defaultRules;
  });

  // UI状态 - 支持外部控制或内部状态
  const [internalActiveTab, setInternalActiveTab] = useState<EditorTabType>('basic');
  const activeTab = externalActiveTab ?? internalActiveTab;
  const setActiveTab = onExternalTabChange ?? setInternalActiveTab;
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>([]);
  const [previewMode, setPreviewMode] = useState<TemplatePreviewSide>('front');
  const [previewDark, setPreviewDark] = useState(false);
  const [showPromptPreview, setShowPromptPreview] = useState(false);
  // 字段重命名后的引用同步通知（瞬时）
  const [renameNotice, setRenameNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!renameNotice) return;
    const timer = setTimeout(() => setRenameNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [renameNotice]);

  // 代码编辑器子 tab 状态（参考技能编辑器分栏布局）
  type CodeSubTab = 'front' | 'back' | 'css';
  const [codeSubTab, setCodeSubTab] = useState<CodeSubTab>('front');
  const cmContainerRef = useRef<HTMLDivElement>(null);
  // CodeMirror 实例引用（桌面/移动端同一时刻只挂载一个），用于光标处插入
  const editorRef = useRef<ReactCodeMirrorRef>(null);

  // 暗色模式检测
  const [isDarkMode, setIsDarkMode] = useState(() => {
    if (typeof document !== 'undefined') {
      return document.documentElement.classList.contains('dark');
    }
    return false;
  });

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDarkMode(document.documentElement.classList.contains('dark'));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => observer.disconnect();
  }, []);

  // CodeMirror 扩展 - 根据子 tab 切换语言
  const cmExtensions = useMemo(() => {
    const lang = codeSubTab === 'css' ? cssLang() : html();
    return [lang, EditorView.lineWrapping];
  }, [codeSubTab]);

  const cmTheme = isDarkMode ? vscodeDark : vscodeLight;

  // 获取当前代码子 tab 对应的值
  const codeValue = useMemo(() => {
    switch (codeSubTab) {
      case 'front': return formData.front_template;
      case 'back': return formData.back_template;
      case 'css': return formData.css_style;
    }
  }, [codeSubTab, formData.front_template, formData.back_template, formData.css_style]);

  // 更新当前代码子 tab 的值
  const handleCodeChange = useCallback((value: string) => {
    switch (codeSubTab) {
      case 'front':
        setFormData(prev => ({ ...prev, front_template: value }));
        break;
      case 'back':
        setFormData(prev => ({ ...prev, back_template: value }));
        break;
      case 'css':
        setFormData(prev => ({ ...prev, css_style: value }));
        break;
    }
  }, [codeSubTab]);

  // 光标处插入文本（CodeMirror 未挂载时降级为追加）
  const insertAtCursor = useCallback((text: string, cursorOffset?: number) => {
    const view = editorRef.current?.view;
    if (!view) {
      handleCodeChange(`${codeValue ?? ''}${text}`);
      return;
    }
    const { from, to } = view.state.selection.main;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + (cursorOffset ?? text.length) },
    });
    view.focus();
  }, [handleCodeChange, codeValue]);

  // 用一对标签包裹选区（无选区则把光标放到标签中间）
  const wrapSelection = useCallback((open: string, close: string) => {
    const view = editorRef.current?.view;
    if (!view) {
      handleCodeChange(`${codeValue ?? ''}${open}${close}`);
      return;
    }
    const { from, to } = view.state.selection.main;
    const selected = view.state.sliceDoc(from, to);
    view.dispatch({
      changes: { from, to, insert: `${open}${selected}${close}` },
      selection: { anchor: from + open.length, head: from + open.length + selected.length },
    });
    view.focus();
  }, [handleCodeChange, codeValue]);

  // 验证JSON
  const validateJson = (jsonString: string): boolean => {
    try {
      JSON.parse(jsonString);
      return true;
    } catch (e: unknown) {
      return false;
    }
  };

  // 预览渲染防抖：避免每次按键都同步跑 Mustache 管线并整页重载预览 iframe（srcDoc 变化即重新导航）
  const debouncedFormData = useDebounce(formData, 300);
  const debouncedPreviewJson = useDebounce(previewDataJson, 300);
  const parsedPreviewData = useMemo(() => {
    try {
      return JSON.parse(debouncedPreviewJson);
    } catch (e: unknown) {
      return {};
    }
  }, [debouncedPreviewJson]);

  // 传给统一渲染引擎的模板数据（TemplateRenderService 接受 CustomAnkiTemplate）
  const previewTemplateData = useMemo<CustomAnkiTemplate>(() => ({
    id: template?.id ?? 'draft-template',
    name: debouncedFormData.name,
    description: debouncedFormData.description,
    author: debouncedFormData.author,
    version: debouncedFormData.version,
    preview_front: debouncedFormData.preview_front,
    preview_back: debouncedFormData.preview_back,
    preview_data_json: debouncedPreviewJson,
    front_template: debouncedFormData.front_template,
    back_template: debouncedFormData.back_template,
    css_style: debouncedFormData.css_style,
    note_type: debouncedFormData.note_type,
    generation_prompt: debouncedFormData.generation_prompt,
    fields: debouncedFormData.fields,
    field_extraction_rules: {},
    created_at: template?.created_at ?? '',
    updated_at: template?.updated_at ?? '',
    is_active: debouncedFormData.is_active,
    is_built_in: template?.is_built_in ?? false,
  }), [debouncedFormData, debouncedPreviewJson, template]);

  // 渲染预览：走统一的 TemplateRenderService（支持 {{FrontSide}}/{{hint:}}/{{type:}} 等
  // Anki 语法），并把结构化渲染问题列表透出到预览面板，不再吞掉渲染问题。
  const preview = useMemo<{ html: string; issues: TemplateRenderIssue[] }>(() => {
    const detailed = TemplateRenderService.renderCardDetailed(
      {
        fields: parsedPreviewData,
        tags: (parsedPreviewData as Record<string, unknown>).Tags
          ?? (parsedPreviewData as Record<string, unknown>).tags,
      },
      previewTemplateData,
    );
    const side = previewMode === 'front' ? detailed.front : detailed.back;
    return { html: side.html, issues: side.issues };
  }, [previewMode, parsedPreviewData, previewTemplateData]);

  // 示例数据（未防抖，供字段级快速编辑；JSON 无效时为 null）
  const sampleDataLive = useMemo<Record<string, unknown> | null>(() => {
    try {
      const parsed: unknown = JSON.parse(previewDataJson);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch (e: unknown) {
      return null;
    }
  }, [previewDataJson]);

  const handleSampleFieldChange = useCallback((field: string, value: unknown) => {
    setPreviewDataJson(prev => {
      try {
        const parsed: unknown = JSON.parse(prev);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return prev;
        (parsed as Record<string, unknown>)[field] = value;
        return JSON.stringify(parsed, null, 2);
      } catch (e: unknown) {
        return prev;
      }
    });
  }, []);

  // 模板静态检查（当前子 tab；CSS 不检查），使用防抖值避免输入过程中的抖动
  const lintIssues = useMemo(() => {
    if (codeSubTab === 'css') return [];
    const tpl = codeSubTab === 'front' ? debouncedFormData.front_template : debouncedFormData.back_template;
    const extraKeys = sampleDataLive ? Object.keys(sampleDataLive) : [];
    return lintTemplate(tpl, debouncedFormData.fields, extraKeys);
  }, [codeSubTab, debouncedFormData.front_template, debouncedFormData.back_template, debouncedFormData.fields, sampleDataLive]);

  // 模板含 <script> 时的信息级提示（脚本会随模板保存，但应用内预览/复习不执行）
  const hasScriptTag = useMemo(
    () => containsScriptTag(debouncedFormData.front_template) || containsScriptTag(debouncedFormData.back_template),
    [debouncedFormData.front_template, debouncedFormData.back_template],
  );

  // 模板中实际引用到的字段集合（字段管理器的「已引用」标记）
  const usedFields = useMemo(() => {
    const refs = extractFieldReferences(formData.front_template);
    extractFieldReferences(formData.back_template).forEach(name => refs.add(name));
    return refs;
  }, [formData.front_template, formData.back_template]);

  // ===== 未保存更改跟踪（内联提示条，无弹窗） =====
  const snapshot = JSON.stringify({ formData, previewDataJson, fieldExtractionRules });
  const initialStateRef = useRef<{
    snapshot: string;
    formData: typeof formData;
    previewDataJson: string;
    rules: Record<string, FieldExtractionRule>;
  } | null>(null);
  if (initialStateRef.current === null) {
    initialStateRef.current = { snapshot, formData, previewDataJson, rules: fieldExtractionRules };
  }
  const isDirty = snapshot !== initialStateRef.current.snapshot;

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  const discardChanges = useCallback(() => {
    const initial = initialStateRef.current;
    if (!initial) return;
    setFormData(initial.formData);
    setPreviewDataJson(initial.previewDataJson);
    setFieldExtractionRules(initial.rules);
    setValidationErrors([]);
  }, []);

  // 验证表单
  const validateForm = (): ValidationError[] => {
    const errors: ValidationError[] = [];

    if (!formData.name.trim()) {
      errors.push({ field: 'name', message: t('template_name_empty') });
    }

    if (!formData.description.trim()) {
      errors.push({ field: 'description', message: t('description_empty') });
    }

    // generation_prompt 不再必填：留空时保存前自动生成默认提示词（见 handleSubmit）

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

    // 字段提取规则的描述不再必填：留空时保存前自动补默认描述（见 handleSubmit）

    return errors;
  };

  // 处理字段变化（同步维护提取规则，保持与字段顺序一致）
  const handleFieldsChange = (newFields: string[]) => {
    setFormData(prev => ({ ...prev, fields: newFields }));

    const newRules: Record<string, FieldExtractionRule> = {};
    newFields.forEach(field => {
      newRules[field] = fieldExtractionRules[field] ?? buildDefaultRule(field);
    });
    setFieldExtractionRules(newRules);
  };

  // 添加字段（保证名称唯一）
  const addField = () => {
    let index = formData.fields.length + 1;
    let newFieldName = `Field${index}`;
    while (formData.fields.includes(newFieldName)) {
      index += 1;
      newFieldName = `Field${index}`;
    }
    handleFieldsChange([...formData.fields, newFieldName]);
  };

  // 删除字段
  const removeField = (index: number) => {
    const newFields = formData.fields.filter((_, i) => i !== index);
    handleFieldsChange(newFields);
  };

  // 上移/下移字段
  const moveField = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= formData.fields.length) return;
    const newFields = [...formData.fields];
    [newFields[index], newFields[target]] = [newFields[target], newFields[index]];
    handleFieldsChange(newFields);
  };

  // 提交式字段重命名：校验唯一性 + 迁移提取规则 + 同步模板引用与示例数据键
  const commitRenameField = (index: number, newName: string): FieldRenameResult => {
    const oldName = formData.fields[index];
    if (!newName.trim()) {
      return { ok: false, error: tAnki('templateEditor.renameEmptyName') as string };
    }
    const trimmed = newName.trim();
    if (formData.fields.some((field, i) => i !== index && field === trimmed)) {
      return { ok: false, error: tAnki('templateEditor.renameDuplicate', { name: trimmed }) as string };
    }
    if (oldName === trimmed) return { ok: true };

    const frontSync = renameFieldReferences(formData.front_template, oldName, trimmed);
    const backSync = renameFieldReferences(formData.back_template, oldName, trimmed);
    const newFields = [...formData.fields];
    newFields[index] = trimmed;

    setFormData(prev => ({
      ...prev,
      fields: newFields,
      front_template: frontSync.result,
      back_template: backSync.result,
    }));
    setFieldExtractionRules(prev => {
      const next: Record<string, FieldExtractionRule> = {};
      newFields.forEach(field => {
        if (field === trimmed) {
          next[field] = prev[oldName] ?? buildDefaultRule(field);
        } else {
          next[field] = prev[field] ?? buildDefaultRule(field);
        }
      });
      return next;
    });
    // 同步示例数据键名
    setPreviewDataJson(prev => {
      try {
        const parsed: unknown = JSON.parse(prev);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return prev;
        const record = parsed as Record<string, unknown>;
        if (Object.prototype.hasOwnProperty.call(record, oldName)) {
          record[trimmed] = record[oldName];
          delete record[oldName];
          return JSON.stringify(record, null, 2);
        }
        return prev;
      } catch (e: unknown) {
        return prev;
      }
    });

    const syncedCount = frontSync.count + backSync.count;
    setRenameNotice(
      (syncedCount > 0
        ? tAnki('templateEditor.renameSynced', { count: syncedCount })
        : tAnki('templateEditor.renameSyncedNone')) as string
    );
    return { ok: true };
  };

  // 必填标记切换
  const toggleFieldRequired = (field: string, required: boolean) => {
    setFieldExtractionRules(prev => ({
      ...prev,
      [field]: { ...(prev[field] ?? buildDefaultRule(field)), is_required: required },
    }));
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
      // 可选字段留空时自动补默认值（后端校验要求非空，但不应阻塞用户保存）
      const effectivePrompt = formData.generation_prompt.trim()
        ? formData.generation_prompt
        : t('generation_prompt_auto_default', {
            name: formData.name,
            fields: formData.fields.join(', '),
          });
      const effectiveRules: Record<string, FieldExtractionRule> = {};
      Object.entries(fieldExtractionRules).forEach(([field, rule]) => {
        effectiveRules[field] = rule.description && rule.description.trim()
          ? rule
          : { ...rule, description: t('field_description', { field }) };
      });

      const templateData: CreateTemplateRequest = {
        ...formData,
        generation_prompt: effectivePrompt,
        preview_data_json: previewDataJson,
        field_extraction_rules: effectiveRules
      };

      await onSave(templateData);
      // 保存成功后以当前内容为新基线，清除未保存标记
      initialStateRef.current = {
        snapshot: JSON.stringify({ formData, previewDataJson, fieldExtractionRules }),
        formData,
        previewDataJson,
        rules: fieldExtractionRules,
      };
    } catch (error: unknown) {
      console.error('Failed to save template:', error);
      setValidationErrors([{ field: 'general', message: error instanceof Error ? error.message : t('save_failed') }]);
    } finally {
      setIsSubmitting(false);
    }
  };

  // 复制JSON模板
  const copyJsonTemplate = () => {
    const templateJson: Record<string, unknown> = {};
    formData.fields.forEach(field => {
      if (field.toLowerCase() === 'tags') {
        templateJson[field] = [t('tag_1'), t('tag_2')];
      } else {
        templateJson[field] = t('field_example_content', { field });
      }
    });

    const jsonStr = JSON.stringify(templateJson, null, 2);
    setPreviewDataJson(jsonStr);
    copyTextToClipboard(jsonStr);
  };

  // 完整提示词预览用模板对象（替代原先的 as any 转型）
  const promptPreviewTemplate = useMemo<CustomAnkiTemplate>(() => ({
    id: template?.id ?? 'draft-template',
    name: formData.name,
    description: formData.description,
    author: formData.author,
    version: formData.version,
    preview_front: formData.preview_front,
    preview_back: formData.preview_back,
    preview_data_json: previewDataJson,
    note_type: formData.note_type,
    fields: formData.fields,
    generation_prompt: formData.generation_prompt,
    front_template: formData.front_template,
    back_template: formData.back_template,
    css_style: formData.css_style,
    field_extraction_rules: fieldExtractionRules,
    created_at: template?.created_at ?? '',
    updated_at: template?.updated_at ?? '',
    is_active: formData.is_active,
    is_built_in: template?.is_built_in ?? false,
  }), [formData, fieldExtractionRules, previewDataJson, template]);

  // 代码子 tab 切换按钮组（桌面/移动共用），含 <script> 信息级提示
  const renderCodeSubTabs = () => (
    <>
      <div className="flex gap-1 p-1 bg-muted/30 rounded-lg">
        <DsButton variant="ghost" size="sm" className={`flex-1 !px-3 !py-1.5 !rounded-md text-xs font-medium ${codeSubTab === 'front' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`} onClick={() => setCodeSubTab('front')}>
          {t('front_template_title')}
        </DsButton>
        <DsButton variant="ghost" size="sm" className={`flex-1 !px-3 !py-1.5 !rounded-md text-xs font-medium ${codeSubTab === 'back' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`} onClick={() => setCodeSubTab('back')}>
          {t('back_template_title')}
        </DsButton>
        <DsButton variant="ghost" size="sm" className={`flex-1 !px-3 !py-1.5 !rounded-md text-xs font-medium ${codeSubTab === 'css' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`} onClick={() => setCodeSubTab('css')}>
          {t('css_style_title')}
        </DsButton>
      </div>
      {hasScriptTag && (
        <div className="flex items-start gap-1.5 px-2 py-1.5 rounded-md bg-info/10 text-info text-xs" role="status">
          <Info size={14} weight="bold" className="shrink-0 mt-0.5" />
          <span>{t('script_in_template_notice')}</span>
        </div>
      )}
    </>
  );

  const renderPreviewPanel = (compact: boolean) => (
    <TemplateEditorPreviewPanel
      html={preview.html}
      css={debouncedFormData.css_style}
      renderIssues={preview.issues}
      previewSide={previewMode}
      onPreviewSideChange={setPreviewMode}
      darkPreview={previewDark}
      onDarkPreviewChange={setPreviewDark}
      fields={formData.fields}
      sampleData={sampleDataLive}
      onSampleFieldChange={handleSampleFieldChange}
      compact={compact}
    />
  );

  return (
    <div className={`minimal-template-editor ${hideSidebar ? 'no-sidebar' : ''} ${(activeTab === 'templates' || activeTab === 'styles') ? 'code-mode' : ''}`}>
      {/* 侧边栏导航 - 可隐藏 */}
      {!hideSidebar && (
        <div className="editor-sidebar">
          <nav className="editor-nav">
            <DsButton variant="ghost" size="sm" className={`nav-item ${activeTab === 'basic' ? 'active' : ''}`} onClick={() => setActiveTab('basic')}>
              <FileText size={18} />
              {t('basic_info')}
            </DsButton>
            <DsButton variant="ghost" size="sm" className={`nav-item ${activeTab === 'templates' || activeTab === 'styles' ? 'active' : ''}`} onClick={() => { setActiveTab('templates'); setCodeSubTab('front'); }}>
              <Code size={18} />
              {t('template_code')}
            </DsButton>
            <DsButton variant="ghost" size="sm" className={`nav-item ${activeTab === 'data' ? 'active' : ''}`} onClick={() => setActiveTab('data')}>
              <Database size={18} />
              {t('preview_data')}
            </DsButton>
            <DsButton variant="ghost" size="sm" className={`nav-item ${activeTab === 'rules' ? 'active' : ''}`} onClick={() => setActiveTab('rules')}>
              <Gear size={18} />
              {t('extraction_rules')}
            </DsButton>
            <DsButton variant="ghost" size="sm" className={`nav-item ${activeTab === 'advanced' ? 'active' : ''}`} onClick={() => setActiveTab('advanced')}>
              <Gear size={18} />
              {t('advanced_settings')}
            </DsButton>
          </nav>
        </div>
      )}

      {/* 主内容区 */}
      <div className="editor-main">
        {/* 内容区域 */}
        <div className={`editor-content ${(activeTab === 'templates' || activeTab === 'styles') ? 'editor-content-code' : ''}`}>
          {/* 错误提示 */}
          {validationErrors.length > 0 && (
            <div className="validation-alert">
              <WarningCircle size={16} />
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
            <div className="space-y-6">
              <div>
                <h2 className="text-base font-semibold text-foreground">{t('basic_info')}</h2>
                <p className="text-xs text-muted-foreground mt-0.5">{t('basic_info_desc')}</p>
              </div>
                <div className="form-grid">
                  <div className="form-field">
                    <Label className="field-label required">{t('template_name_label')}</Label>
                    <Input
                      type="text"
                      value={formData.name}
                      onChange={(e) => setFormData({...formData, name: e.target.value})}
                      placeholder={t('form_name_placeholder')}
/>
                    <span className="field-hint">{t('template_name_hint')}</span>
                  </div>

                  <div className="form-field">
                    <Label className="field-label">{t('author')}</Label>
                    <Input
                      type="text"
                      value={formData.author}
                      onChange={(e) => setFormData({...formData, author: e.target.value})}
                      placeholder={t('form_author_placeholder')}
/>
                  </div>

                  <div className="form-field">
                    <Label className="field-label">{t('version')}</Label>
                    {/* 版本号只读：由后端保存成功后自动递增；表单值不会作为乐观锁
                        expected_version 提交（手动改版本号曾必然触发保存失败） */}
                    <Input
                      type="text"
                      value={formData.version}
                      readOnly
                      aria-readonly="true"
                      className="opacity-70 cursor-default"
/>
                    <span className="field-hint">{t('version_readonly_hint')}</span>
                  </div>

                  <div className="form-field">
                    <Label className="field-label">{t('active_status')}</Label>
                    <div className="flex items-center gap-3">
                      <Switch
                        checked={formData.is_active}
                        onCheckedChange={(checked) => setFormData({...formData, is_active: checked})}
/>
                      <span className="text-sm text-muted-foreground">
                        {formData.is_active ? t('active') : t('inactive')}
                      </span>
                    </div>
                  </div>

                  <div className="form-field full-width">
                    <Label className="field-label required">{t('form_description')}</Label>
                    <Textarea
                      value={formData.description}
                      onChange={(e) => setFormData({...formData, description: e.target.value})}
                      placeholder={t('form_description_placeholder')}
                      rows={3}
/>
                  </div>

                  <div className="form-field">
                    <Label className="field-label">{t('form_note_type')}</Label>
                    <Select
                      value={formData.note_type}
                      onValueChange={(value) => setFormData({...formData, note_type: value})}
                    >
                      <SelectTrigger className="flex h-9 w-full rounded-md border border-transparent bg-transparent hover:bg-[var(--interactive-hover)] focus-within:bg-background focus-within:border-border/60 focus-within:ring-1 focus-within:ring-border/50 px-3 py-2 text-sm text-foreground focus:outline-none transition-colors">
                        <SelectValue placeholder={t('note_type_placeholder')} />
                      </SelectTrigger>
                      <SelectContent>
                        {/* 历史模板可能带非标准 note_type，保留为可选项避免值被静默丢失 */}
                        {(NOTE_TYPE_OPTIONS.includes(formData.note_type)
                          ? NOTE_TYPE_OPTIONS
                          : [formData.note_type, ...NOTE_TYPE_OPTIONS].filter(Boolean)
                        ).map((noteType) => (
                          <SelectItem key={noteType} value={noteType}>{noteType}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <span className="field-hint">{t('note_type_hint')}</span>
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

              <div className="border-t border-border/30 pt-5">
                <h2 className="text-base font-semibold text-foreground">{t('field_management')}</h2>
                <p className="text-xs text-muted-foreground mt-0.5 mb-4">{t('field_management_desc')}</p>
              </div>
              <TemplateEditorFieldManager
                fields={formData.fields}
                rules={fieldExtractionRules}
                usedFields={usedFields}
                onAddField={addField}
                onRemoveField={removeField}
                onMoveField={moveField}
                onRenameField={commitRenameField}
                onToggleRequired={toggleFieldRequired}
                notice={renameNotice}
/>
            </div>
          )}

          {/* 模板代码（含样式） - 桌面分栏 / 移动端上下布局 */}
          {(activeTab === 'templates' || activeTab === 'styles') && (
            <div className="template-code-split-panel">
              {/* 移动端：预览作为中屏，编辑器 portal 到 MobileSlidingLayout 的右屏 */}
              {isSmallScreen ? (
                <>
                  {/* 中屏：实时预览面板 */}
                  <div className="flex-1 min-h-0 overflow-y-auto">
                    <div className="p-3">
                      {renderPreviewPanel(true)}
                    </div>
                  </div>
                  {/* 右屏：代码编辑器（portal 到 MobileSlidingLayout 的 rightPanel） */}
                  {mobileEditorPortalTarget && createPortal(
                    <div className="h-full flex flex-col">
                      {/* 代码子 tab 切换栏 + 插入按钮条 */}
                      <div className="flex-none px-3 py-2 border-b border-border/30 space-y-2">
                        {renderCodeSubTabs()}
                        {codeSubTab !== 'css' && (
                          <TemplateEditorInsertBar
                            fields={formData.fields}
                            isBackTemplate={codeSubTab === 'back'}
                            onInsertText={insertAtCursor}
                            onWrapSelection={wrapSelection}
                            lintIssues={lintIssues}
/>
                        )}
                      </div>
                      {/* 代码编辑器 */}
                      <div className="flex-1 min-h-0 overflow-hidden relative">
                        <CodeMirror
                          ref={editorRef}
                          value={codeValue}
                          onChange={handleCodeChange}
                          extensions={cmExtensions}
                          theme={cmTheme}
                          height="100%"
                          className="h-full template-codemirror-editor"
                          basicSetup={{ lineNumbers: true, highlightActiveLine: true, foldGutter: true, bracketMatching: true, closeBrackets: true, autocompletion: true }}
/>
                      </div>
                    </div>,
                    mobileEditorPortalTarget
                  )}
                </>
              ) : (
              /* 桌面端：左侧编辑 / 右侧实时预览 */
              <HorizontalResizable
                initial={0.55}
                minLeft={0.35}
                minRight={0.28}
                className="h-full"
                left={
                  <div className="h-full w-full flex flex-col min-w-0">
                    <div className="flex-none px-3 pt-3 pb-2 space-y-2 border-b border-border/30">
                      {renderCodeSubTabs()}
                      <p className="text-xs text-muted-foreground/70">
                        {codeSubTab === 'front' && t('front_template_desc')}
                        {codeSubTab === 'back' && t('back_template_desc')}
                        {codeSubTab === 'css' && t('css_style_desc')}
                      </p>
                      {codeSubTab !== 'css' && (
                        <TemplateEditorInsertBar
                          fields={formData.fields}
                          isBackTemplate={codeSubTab === 'back'}
                          onInsertText={insertAtCursor}
                          onWrapSelection={wrapSelection}
                          lintIssues={lintIssues}
/>
                      )}
                    </div>
                    <div ref={cmContainerRef} className="flex-1 min-h-0 overflow-hidden relative">
                      <CodeMirror
                        ref={editorRef}
                        value={codeValue}
                        onChange={handleCodeChange}
                        extensions={cmExtensions}
                        theme={cmTheme}
                        height="100%"
                        className="h-full template-codemirror-editor"
                        basicSetup={{
                          lineNumbers: true,
                          highlightActiveLineGutter: true,
                          highlightActiveLine: true,
                          foldGutter: true,
                          dropCursor: true,
                          allowMultipleSelections: true,
                          indentOnInput: true,
                          bracketMatching: true,
                          closeBrackets: true,
                          autocompletion: true,
                          rectangularSelection: true,
                          crosshairCursor: false,
                          highlightSelectionMatches: true,
                        }}
/>
                      <CodeMirrorScrollOverlay containerRef={cmContainerRef} />
                    </div>
                  </div>
                }
                right={
                  <div className="h-full w-full flex flex-col min-w-0">
                    <CustomScrollArea className="flex-1" viewportClassName="p-4">
                      {renderPreviewPanel(false)}
                    </CustomScrollArea>
                  </div>
                }
/>
              )}
            </div>
          )}

          {/* 预览数据 */}
          {activeTab === 'data' && (
            <div className="space-y-4">
              <div>
                <h2 className="text-base font-semibold text-foreground">{t('preview_data')}</h2>
                <p className="text-xs text-muted-foreground mt-0.5">{t('preview_data_desc')}</p>
              </div>
                <div className="mb-3">
                  <DsButton
                    type="button"
                    variant="ghost"
                    onClick={copyJsonTemplate}
                  >
                    <Copy size={16} className="mr-2" />
                    {t('generate_template_json')}
                  </DsButton>
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
                    {t('json_invalid')}
                  </div>
                )}
            </div>
          )}

          {/* 提取规则 */}
          {activeTab === 'rules' && (
            <div className="space-y-4">
              <div>
                <h2 className="text-base font-semibold text-foreground">{t('field_extraction_rules')}</h2>
                <p className="text-xs text-muted-foreground mt-0.5">{t('extraction_rules_desc')}</p>
              </div>
                <div className="rules-editor">
                  {Object.entries(fieldExtractionRules).map(([fieldName, rule]) => (
                    <div key={fieldName} className="mb-4 p-4 rounded-xl border border-border bg-muted/30">
                      <h3 className="text-base font-semibold mb-4">{fieldName}</h3>
                        {/* 400px 窄屏三列过挤：<sm 单列堆叠，sm 起恢复三列（桌面视觉不变） */}
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                          <div className="form-field sm:col-span-1">
                            <Label className="field-label">{t('field_type_label')}</Label>
                            <Select
                              value={isFieldType(rule.field_type) ? rule.field_type : 'Text'}
                              onValueChange={(value) => {
                                if (!isFieldType(value)) return;
                                setFieldExtractionRules({
                                  ...fieldExtractionRules,
                                  [fieldName]: { ...rule, field_type: value }
                                });
                              }}
                            >
                              <SelectTrigger className="flex h-9 w-full rounded-md border border-transparent bg-transparent hover:bg-[var(--interactive-hover)] focus-within:bg-background focus-within:border-border/60 focus-within:ring-1 focus-within:ring-border/50 px-3 py-2 text-sm text-foreground focus:outline-none transition-colors">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="Text">{t('field_type.text')}</SelectItem>
                                <SelectItem value="Number">{t('field_type.number')}</SelectItem>
                                <SelectItem value="Boolean">{t('field_type.boolean')}</SelectItem>
                                <SelectItem value="Date">{t('field_type.date')}</SelectItem>
                                <SelectItem value="Array">{t('field_type.array')}</SelectItem>
                                <SelectItem value="RichText">{t('field_type.rich_text')}</SelectItem>
                                <SelectItem value="Formula">{t('field_type.formula')}</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>

                          <div className="form-field sm:col-span-2">
                            <Label className="field-label">{t('field_description_label')}</Label>
                            <Textarea
                              value={rule.description}
                              onChange={(e) => {
                                setFieldExtractionRules({
                                  ...fieldExtractionRules,
                                  [fieldName]: { ...rule, description: e.target.value }
                                });
                              }}
                              placeholder={t('field_purpose_placeholder')}
                              rows={2}
/>
                          </div>

                          <div className="form-field sm:col-span-1">
                            <Label className="field-label">{t('is_required_label')}</Label>
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
                                {rule.is_required ? t('required') : t('optional_label')}
                              </span>
                            </div>
                          </div>

                          <div className="form-field sm:col-span-2">
                            <Label className="field-label">{t('field_default_value')}</Label>
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
              <div className="space-y-4">
                <div>
                  <h2 className="text-base font-semibold text-foreground">{t('advanced_settings')}</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">{t('advanced_settings_desc')}</p>
                </div>
                  <div className="form-field">
                    <div className="flex items-center justify-between mb-2">
                      <Label className="field-label">{t('core_requirements')}</Label>
                      <DsButton
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setShowPromptPreview(!showPromptPreview)}
                      >
                        {showPromptPreview ? <EyeSlash size={16} className="mr-2" /> : <Eye size={16} className="mr-2" />}
                        {showPromptPreview ? t('hide') : t('preview')}{t('full_prompt')}
                      </DsButton>
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
                <div className="space-y-4 mt-4">
                  <div>
                    <h2 className="text-base font-semibold text-foreground">{t('full_prompt_preview')}</h2>
                    <p className="text-xs text-muted-foreground mt-0.5">{t('full_prompt_preview_desc')}</p>
                  </div>
                    <div className="preview-content font-mono text-sm bg-muted p-4 rounded-md">
                      {templateService.generatePrompt(promptPreviewTemplate)}
                    </div>
                </div>
              )}
            </>
          )}

        </div>

        {/* 底部操作栏 - 固定在 editor-main 底部，不参与滚动 */}
        <div className="flex-none px-4 py-1.5 border-t border-border/40 flex items-center justify-between gap-3">
          <div className="footer-info flex items-center gap-3 min-w-0">
            {isDirty && (
              <span className="template-editor-dirty-bar" role="status">
                <span className="template-editor-dirty-dot" aria-hidden="true" />
                {tAnki('templateEditor.unsavedChanges')}
                <button
                  type="button"
                  className="template-editor-dirty-discard"
                  onClick={discardChanges}
                >
                  {tAnki('templateEditor.discardChanges')}
                </button>
              </span>
            )}
            {mode === 'edit' && template && (
              <span className="text-sm text-muted-foreground truncate">
                {t('created_at_label', { date: new Date(template.created_at).toLocaleDateString() })} ·
                {t('updated_at_label', { date: new Date(template.updated_at).toLocaleDateString() })}
              </span>
            )}
          </div>
          <div className="flex gap-3 shrink-0">
            <DsButton type="button" variant="ghost" onClick={onCancel}>
              {t('cancel_button')}
            </DsButton>
            <DsButton
              type="button"
              onClick={handleSubmit}
              disabled={isSubmitting}
            >
              {isSubmitting && <div className="loading-spinner mr-2" />}
              {mode === 'create' ? t('submit_create') : t('submit_save')}
            </DsButton>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MinimalTemplateEditor;

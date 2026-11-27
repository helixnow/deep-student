import React, { useState, useEffect, useMemo, useRef, useCallback, useImperativeHandle } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  FileText, Code, Database, ListChecks, GearSix,
  Eye, EyeSlash, WarningCircle, Copy, Check, Info,
  Plus, CircleNotch, CheckCircle,
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
import { Alert } from './ui/shad/Alert';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './ui/shad/Select';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SettingsGroup, SettingRow, SwitchRow } from '@/components/settings/settingsTabPrimitives';
import CodeMirror, { ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { html } from '@codemirror/lang-html';
import { css as cssLang } from '@codemirror/lang-css';
import { EditorView } from '@codemirror/view';
import { vscodeDark, vscodeLight } from '@uiw/codemirror-theme-vscode';
import { HorizontalResizable } from './shared/Resizable';
import { CodeMirrorScrollOverlay } from './skills-management/CodeMirrorScrollOverlay';
import {
  TemplateEditorInsertBar,
  TemplateEditorSnippetMenu,
  TemplateEditorLintBar,
} from './TemplateEditorInsertBar';
import { TemplateEditorPreviewPanel, TemplatePreviewSide } from './TemplateEditorPreviewPanel';
import { TemplateEditorFieldManager, FieldRenameResult } from './TemplateEditorFieldManager';
import { lintTemplate, extractFieldReferences, renameFieldReferences } from './TemplateEditorLint';
import { cn } from '@/utils/cn';
import './MinimalTemplateEditor.css';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { useDebounce } from '@/hooks/useDebounce';

// 编辑器 Tab 类型导出
export type EditorTabType = 'basic' | 'templates' | 'styles' | 'data' | 'rules' | 'advanced';

export interface MinimalTemplateEditorHandle {
  submit: () => void;
  discard: () => void;
}

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
  /** 是否隐藏底部操作栏（当外层顶栏已承载保存/取消操作时置 true） */
  hideFooter?: boolean;
  // 移动端：编辑器 portal 目标容器（由 MobileSlidingLayout 的 rightPanel 提供）
  mobileEditorPortalTarget?: HTMLDivElement | null;
  /** 可选：未保存更改状态变化回调（供外层做离开确认与顶栏状态展示） */
  onDirtyChange?: (dirty: boolean) => void;
  /** 可选：提交中状态变化回调（供外层顶栏按钮同步 loading/disabled） */
  onSubmittingChange?: (submitting: boolean) => void;
}

interface ValidationError {
  field: string;
  message: string;
}

/** 字段类型选项（与 FieldType 联合类型保持一致） */
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
const containsScriptTag = (code: string) => /<script[\s>]/i.test(code);

const formatSampleValue = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(', ');
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

const MinimalTemplateEditor = React.forwardRef<MinimalTemplateEditorHandle, MinimalTemplateEditorProps>(({
  template,
  mode,
  onSave,
  onCancel,
  externalActiveTab,
  onExternalTabChange,
  hideSidebar = false,
  hideFooter = false,
  mobileEditorPortalTarget,
  onDirtyChange,
  onSubmittingChange,
}, ref) => {
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
    css_style: template?.css_style || '.card { padding: 20px; background: white; border-radius: 8px; }',
  });

  // 预览数据JSON
  const [previewDataJson, setPreviewDataJson] = useState(() => {
    if (template?.preview_data_json) {
      try {
        return JSON.stringify(JSON.parse(template.preview_data_json), null, 2);
      } catch {
        return '{}';
      }
    }
    return JSON.stringify({
      Front: t('example_question'),
      Back: t('example_answer'),
      Notes: t('example_notes'),
      Tags: [t('tag_1'), t('tag_2')],
    }, null, 2);
  });

  // 字段默认提取规则
  const buildDefaultRule = useCallback((field: string): FieldExtractionRule => ({
    field_type: field.toLowerCase() === 'tags' ? 'Array' : 'Text',
    is_required: field.toLowerCase() === 'front' || field.toLowerCase() === 'back',
    default_value: field.toLowerCase() === 'tags' ? '[]' : '',
    description: t('field_description', { field }),
  }), [t]);

  // 字段提取规则
  const [fieldExtractionRules, setFieldExtractionRules] = useState<Record<string, FieldExtractionRule>>(() => {
    if (template?.field_extraction_rules) {
      return template.field_extraction_rules;
    }
    const defaultRules: Record<string, FieldExtractionRule> = {};
    formData.fields.forEach((field) => {
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
  const [promptCopied, setPromptCopied] = useState(false);
  const [dataEditMode, setDataEditMode] = useState<'form' | 'json'>('form');
  // 字段重命名后的引用同步通知（瞬时）
  const [renameNotice, setRenameNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!renameNotice) return;
    const timer = setTimeout(() => setRenameNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [renameNotice]);

  useEffect(() => {
    if (!promptCopied) return;
    const timer = setTimeout(() => setPromptCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [promptCopied]);

  // 代码编辑器子 tab 状态
  type CodeSubTab = 'front' | 'back' | 'css';
  const [codeSubTab, setCodeSubTab] = useState<CodeSubTab>('front');
  const cmContainerRef = useRef<HTMLDivElement>(null);
  const jsonCmContainerRef = useRef<HTMLDivElement>(null);
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

  const jsonCmExtensions = useMemo(() => [EditorView.lineWrapping], []);
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
        setFormData((prev) => ({ ...prev, front_template: value }));
        break;
      case 'back':
        setFormData((prev) => ({ ...prev, back_template: value }));
        break;
      case 'css':
        setFormData((prev) => ({ ...prev, css_style: value }));
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
    } catch {
      return false;
    }
  };

  // 预览渲染防抖
  const debouncedFormData = useDebounce(formData, 300);
  const debouncedPreviewJson = useDebounce(previewDataJson, 300);
  const parsedPreviewData = useMemo(() => {
    try {
      return JSON.parse(debouncedPreviewJson);
    } catch {
      return {};
    }
  }, [debouncedPreviewJson]);

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
    } catch {
      return null;
    }
  }, [previewDataJson]);

  const handleSampleFieldChange = useCallback((field: string, value: unknown) => {
    setPreviewDataJson((prev) => {
      try {
        const parsed: unknown = JSON.parse(prev);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return prev;
        (parsed as Record<string, unknown>)[field] = value;
        return JSON.stringify(parsed, null, 2);
      } catch {
        return prev;
      }
    });
  }, []);

  const handleSampleTextInput = useCallback((field: string, raw: string) => {
    const original = sampleDataLive?.[field];
    if (Array.isArray(original)) {
      handleSampleFieldChange(
        field,
        raw.split(',').map((item) => item.trim()).filter((item) => item !== ''),
      );
    } else {
      handleSampleFieldChange(field, raw);
    }
  }, [sampleDataLive, handleSampleFieldChange]);

  // 模板静态检查（当前子 tab；CSS 不检查）
  const lintIssues = useMemo(() => {
    if (codeSubTab === 'css') return [];
    const tpl = codeSubTab === 'front' ? debouncedFormData.front_template : debouncedFormData.back_template;
    const extraKeys = sampleDataLive ? Object.keys(sampleDataLive) : [];
    return lintTemplate(tpl, debouncedFormData.fields, extraKeys);
  }, [codeSubTab, debouncedFormData.front_template, debouncedFormData.back_template, debouncedFormData.fields, sampleDataLive]);

  const hasScriptTag = useMemo(
    () => containsScriptTag(debouncedFormData.front_template) || containsScriptTag(debouncedFormData.back_template),
    [debouncedFormData.front_template, debouncedFormData.back_template],
  );

  // 模板中实际引用到的字段集合
  const usedFields = useMemo(() => {
    const refs = extractFieldReferences(formData.front_template);
    extractFieldReferences(formData.back_template).forEach((name) => refs.add(name));
    return refs;
  }, [formData.front_template, formData.back_template]);

  // ===== 未保存更改跟踪 =====
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

  useEffect(() => {
    onSubmittingChange?.(isSubmitting);
  }, [isSubmitting, onSubmittingChange]);

  const discardChanges = useCallback(() => {
    const initial = initialStateRef.current;
    if (!initial) return;
    setFormData(initial.formData);
    setPreviewDataJson(initial.previewDataJson);
    setFieldExtractionRules(initial.rules);
    setValidationErrors([]);
  }, []);

  // 验证表单
  const validateForm = useCallback((): ValidationError[] => {
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

    const missingRuleFields = formData.fields.filter((field) => !fieldExtractionRules[field]);
    if (missingRuleFields.length > 0) {
      errors.push({
        field: 'field_rules',
        message: t('field_rules_missing', { fields: missingRuleFields.join(', ') }),
      });
    }

    const extraRuleFields = Object.keys(fieldExtractionRules).filter((field) => !formData.fields.includes(field));
    if (extraRuleFields.length > 0) {
      errors.push({
        field: 'field_rules',
        message: t('field_rules_extra', { fields: extraRuleFields.join(', ') }),
      });
    }

    return errors;
  }, [formData, previewDataJson, fieldExtractionRules, t]);

  // 处理字段变化（同步维护提取规则，保持与字段顺序一致）
  const handleFieldsChange = (newFields: string[]) => {
    setFormData((prev) => ({ ...prev, fields: newFields }));

    const newRules: Record<string, FieldExtractionRule> = {};
    newFields.forEach((field) => {
      newRules[field] = fieldExtractionRules[field] ?? buildDefaultRule(field);
    });
    setFieldExtractionRules(newRules);
  };

  const addField = () => {
    let index = formData.fields.length + 1;
    let newFieldName = `Field${index}`;
    while (formData.fields.includes(newFieldName)) {
      index += 1;
      newFieldName = `Field${index}`;
    }
    handleFieldsChange([...formData.fields, newFieldName]);
  };

  const removeField = (index: number) => {
    const newFields = formData.fields.filter((_, i) => i !== index);
    handleFieldsChange(newFields);
  };

  const moveField = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= formData.fields.length) return;
    const newFields = [...formData.fields];
    [newFields[index], newFields[target]] = [newFields[target], newFields[index]];
    handleFieldsChange(newFields);
  };

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

    setFormData((prev) => ({
      ...prev,
      fields: newFields,
      front_template: frontSync.result,
      back_template: backSync.result,
    }));
    setFieldExtractionRules((prev) => {
      const next: Record<string, FieldExtractionRule> = {};
      newFields.forEach((field) => {
        if (field === trimmed) {
          next[field] = prev[oldName] ?? buildDefaultRule(field);
        } else {
          next[field] = prev[field] ?? buildDefaultRule(field);
        }
      });
      return next;
    });
    setPreviewDataJson((prev) => {
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
      } catch {
        return prev;
      }
    });

    const syncedCount = frontSync.count + backSync.count;
    setRenameNotice(
      (syncedCount > 0
        ? tAnki('templateEditor.renameSynced', { count: syncedCount })
        : tAnki('templateEditor.renameSyncedNone')) as string,
    );
    return { ok: true };
  };

  const toggleFieldRequired = (field: string, required: boolean) => {
    setFieldExtractionRules((prev) => ({
      ...prev,
      [field]: { ...(prev[field] ?? buildDefaultRule(field)), is_required: required },
    }));
  };

  // 提交表单
  const handleSubmit = useCallback(async (e?: React.FormEvent) => {
    if (e) e.preventDefault();

    const errors = validateForm();
    if (errors.length > 0) {
      setValidationErrors(errors);
      return;
    }

    setValidationErrors([]);
    setIsSubmitting(true);

    try {
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
        field_extraction_rules: effectiveRules,
      };

      await onSave(templateData);
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
  }, [validateForm, formData, fieldExtractionRules, previewDataJson, onSave, t]);

  useImperativeHandle(ref, () => ({
    submit: () => {
      void handleSubmit();
    },
    discard: discardChanges,
  }), [handleSubmit, discardChanges]);

  // 生成并复制默认示例 JSON
  const copyJsonTemplate = () => {
    const templateJson: Record<string, unknown> = {};
    formData.fields.forEach((field) => {
      if (field.toLowerCase() === 'tags') {
        templateJson[field] = [t('tag_1'), t('tag_2')];
      } else {
        templateJson[field] = t('field_example_content', { field });
      }
    });

    const jsonStr = JSON.stringify(templateJson, null, 2);
    setPreviewDataJson(jsonStr);
    void copyTextToClipboard(jsonStr);
  };

  // 完整提示词预览用模板对象
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

  const fullPromptText = useMemo(
    () => (showPromptPreview ? templateService.generatePrompt(promptPreviewTemplate) : ''),
    [showPromptPreview, promptPreviewTemplate],
  );

  const handleCopyFullPrompt = useCallback(async () => {
    if (!fullPromptText) return;
    await copyTextToClipboard(fullPromptText);
    setPromptCopied(true);
  }, [fullPromptText]);

  const codeSubTabOptions = useMemo(
    () => [
      { value: 'front' as const, label: t('front_template_title') },
      { value: 'back' as const, label: t('back_template_title') },
      { value: 'css' as const, label: t('css_style_title') },
    ],
    [t],
  );

  const dataModeOptions = useMemo(
    () => [
      { value: 'form' as const, label: t('editor.data_mode_form') },
      { value: 'json' as const, label: t('editor.data_mode_json') },
    ],
    [t],
  );

  const renderCodeToolbar = () => (
    <div className="flex-none space-y-2 border-b border-border/40 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl<CodeSubTab>
          ariaLabel={t('editor.code_subtab_aria')}
          value={codeSubTab}
          onValueChange={setCodeSubTab}
          options={codeSubTabOptions}
          size="compact"
        />
        {codeSubTab !== 'css' && (
          <TemplateEditorSnippetMenu
            fields={formData.fields}
            isBackTemplate={codeSubTab === 'back'}
            onInsertText={insertAtCursor}
            onWrapSelection={wrapSelection}
          />
        )}
      </div>
      {codeSubTab !== 'css' && (
        <TemplateEditorInsertBar
          fields={formData.fields}
          onInsertText={insertAtCursor}
        />
      )}
    </div>
  );

  const renderCodeBottomNotices = () => (
    <>
      {hasScriptTag && (
        <div
          className="flex flex-none items-start gap-2 border-t border-info/25 bg-info/10 px-3 py-2 text-xs text-info"
          role="status"
        >
          <Info size={14} weight="bold" className="mt-0.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 leading-snug">{t('script_in_template_notice')}</span>
        </div>
      )}
      {codeSubTab !== 'css' && <TemplateEditorLintBar lintIssues={lintIssues} />}
    </>
  );

  const renderPreviewPanel = (compact: boolean, showSampleEditor = true) => (
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
      showSampleEditor={showSampleEditor}
    />
  );

  const renderValidationBanner = () => {
    if (validationErrors.length === 0) return null;
    return (
      <Alert variant="destructive" className="flex items-start gap-2.5">
        <WarningCircle size={16} weight="bold" className="mt-0.5 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-1 text-xs leading-relaxed">
          {validationErrors.map((err, index) => (
            <div key={`${err.field}-${index}`}>{err.message}</div>
          ))}
        </div>
      </Alert>
    );
  };

  const isSplitViewTab = activeTab === 'templates' || activeTab === 'styles' || (activeTab === 'data' && !isSmallScreen);
  const jsonValid = validateJson(previewDataJson);

  // 预览数据编辑器左栏内容（表单视图 / JSON 源码双模式）
  const renderDataEditorBody = () => (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex flex-none flex-wrap items-center justify-between gap-2 border-b border-border/40 px-3 py-2">
        <SegmentedControl<'form' | 'json'>
          ariaLabel={t('editor.data_mode_aria')}
          value={dataEditMode}
          onValueChange={setDataEditMode}
          options={dataModeOptions}
          size="compact"
        />
        <DsButton
          type="button"
          variant="ghost"
          size="sm"
          onClick={copyJsonTemplate}
        >
          <Copy size={14} aria-hidden="true" />
          <span>{t('generate_template_json')}</span>
        </DsButton>
      </div>

      {dataEditMode === 'form' ? (
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-4 p-4 sm:p-5">
            {renderValidationBanner()}
            {sampleDataLive === null ? (
              <Alert variant="destructive" className="flex items-start gap-2.5 text-xs">
                <WarningCircle size={16} weight="bold" className="mt-0.5 shrink-0" aria-hidden="true" />
                <div className="space-y-2">
                  <p>{t('editor.data_form_invalid_hint')}</p>
                  <DsButton
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setDataEditMode('json')}
                    className="bg-[color:var(--button-tonal-bg)] text-foreground"
                  >
                    {t('editor.data_mode_json')}
                  </DsButton>
                </div>
              </Alert>
            ) : (
              <SettingsGroup
                title={t('preview_data')}
                description={t('preview_data_desc')}
              >
                {formData.fields.map((field) => {
                  const formatted = formatSampleValue(sampleDataLive[field]);
                  const isLong = formatted.length > 60 || formatted.includes('\n');
                  return (
                    <SettingRow
                      key={field}
                      title={field}
                      controlClassName="[@container_(min-width:600px)]:w-[320px]"
                    >
                      {isLong ? (
                        <Textarea
                          value={formatted}
                          rows={3}
                          placeholder={tAnki('templateEditor.sampleValuePlaceholder') as string}
                          onChange={(e) => handleSampleTextInput(field, e.target.value)}
                          className="min-h-[68px]"
                        />
                      ) : (
                        <Input
                          type="text"
                          value={formatted}
                          placeholder={tAnki('templateEditor.sampleValuePlaceholder') as string}
                          onChange={(e) => handleSampleTextInput(field, e.target.value)}
                        />
                      )}
                    </SettingRow>
                  );
                })}
              </SettingsGroup>
            )}
            <p className="px-1 text-xs text-muted-foreground/70">
              {tAnki('templateEditor.sampleDataHint')}
            </p>
          </div>
        </ScrollArea>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {validationErrors.length > 0 && (
            <div className="flex-none p-3 pb-0">{renderValidationBanner()}</div>
          )}
          <div ref={jsonCmContainerRef} className="relative min-h-0 flex-1 overflow-hidden">
            <CodeMirror
              value={previewDataJson}
              onChange={(value) => setPreviewDataJson(value)}
              extensions={jsonCmExtensions}
              theme={cmTheme}
              height="100%"
              placeholder="{}"
              className="h-full template-codemirror-editor"
              basicSetup={{
                lineNumbers: true,
                highlightActiveLineGutter: true,
                highlightActiveLine: true,
                foldGutter: true,
                bracketMatching: true,
                closeBrackets: true,
                autocompletion: true,
                highlightSelectionMatches: true,
              }}
            />
            <CodeMirrorScrollOverlay containerRef={jsonCmContainerRef} />
          </div>
          {!jsonValid && (
            <div
              className="flex flex-none items-center gap-2 border-t border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              role="alert"
            >
              <WarningCircle size={14} weight="fill" className="shrink-0" aria-hidden="true" />
              <span>{t('json_invalid')}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className={cn('minimal-template-editor', isSplitViewTab && 'code-mode')}>
      {/* 内置侧边栏导航（仅独立使用未隐藏侧栏时渲染） */}
      {!hideSidebar && (
        <aside className="hidden w-52 shrink-0 border-r border-border/40 p-2 md:block">
          <nav className="space-y-0.5" aria-label={t('editor.tabs_aria')}>
            {[
              { id: 'basic' as const, icon: FileText, label: t('basic_info') },
              { id: 'templates' as const, icon: Code, label: t('template_code') },
              { id: 'data' as const, icon: Database, label: t('preview_data') },
              { id: 'rules' as const, icon: ListChecks, label: t('extraction_rules') },
              { id: 'advanced' as const, icon: GearSix, label: t('advanced_settings') },
            ].map(({ id, icon: Icon, label }) => {
              const selected = id === 'templates'
                ? (activeTab === 'templates' || activeTab === 'styles')
                : activeTab === id;
              return (
                <DsButton
                  key={id}
                  variant="nav"
                  onClick={() => {
                    setActiveTab(id);
                    if (id === 'templates') setCodeSubTab('front');
                  }}
                  aria-current={selected ? 'page' : undefined}
                  className={cn(
                    selected && 'bg-[color:var(--sidebar-quiet-active)] font-medium text-foreground',
                  )}
                >
                  <Icon size={16} weight="duotone" />
                  <span className="truncate">{label}</span>
                </DsButton>
              );
            })}
          </nav>
        </aside>
      )}

      {/* 主内容区 */}
      <div className="editor-main">
        {/* 1. 基本信息 */}
        {activeTab === 'basic' && (
          <ScrollArea className="editor-content">
            <div className="mx-auto w-full max-w-4xl space-y-6 px-5 py-6 sm:px-6 lg:px-8">
              {renderValidationBanner()}

              {/* 分组一：基础属性 */}
              <SettingsGroup
                title={t('basic_info')}
                description={t('basic_info_desc')}
              >
                <SettingRow
                  title={t('template_name_label')}
                  description={t('template_name_hint')}
                  controlClassName="[@container_(min-width:600px)]:w-[320px]"
                >
                  <Input
                    type="text"
                    required
                    aria-label={t('template_name_label')}
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder={t('form_name_placeholder')}
                  />
                </SettingRow>

                <SettingRow
                  title={t('form_description')}
                  controlClassName="[@container_(min-width:600px)]:w-[380px]"
                >
                  <Textarea
                    required
                    aria-label={t('form_description')}
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    placeholder={t('form_description_placeholder')}
                    rows={3}
                  />
                </SettingRow>

                <SettingRow
                  title={t('author')}
                  controlClassName="[@container_(min-width:600px)]:w-[240px]"
                >
                  <Input
                    type="text"
                    aria-label={t('author')}
                    value={formData.author}
                    onChange={(e) => setFormData({ ...formData, author: e.target.value })}
                    placeholder={t('form_author_placeholder')}
                  />
                </SettingRow>

                <SettingRow
                  title={t('version')}
                  description={t('version_readonly_hint')}
                >
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-right">
                    <span className="font-mono text-sm font-medium tabular-nums text-foreground">
                      v{formData.version}
                    </span>
                    {mode === 'edit' && template && (
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {t('created_at_label', { date: new Date(template.created_at).toLocaleDateString() })}
                        {' · '}
                        {t('updated_at_label', { date: new Date(template.updated_at).toLocaleDateString() })}
                      </span>
                    )}
                  </div>
                </SettingRow>

                <SwitchRow
                  title={t('active_status')}
                  description={t('editor.active_status_desc')}
                  checked={formData.is_active}
                  onCheckedChange={(checked) => setFormData({ ...formData, is_active: checked })}
                />
              </SettingsGroup>

              {/* 分组二：卡片类型与字段 */}
              <SettingsGroup
                title={t('field_management')}
                description={t('field_management_desc')}
                actions={(
                  <DsButton type="button" variant="ghost" size="sm" onClick={addField}>
                    <Plus size={14} aria-hidden="true" />
                    <span>{t('add_field')}</span>
                  </DsButton>
                )}
              >
                <SettingRow
                  title={t('form_note_type')}
                  description={t('note_type_hint')}
                  controlClassName="[@container_(min-width:600px)]:w-[260px]"
                >
                  <Select
                    value={formData.note_type}
                    onValueChange={(value) => setFormData({ ...formData, note_type: value })}
                  >
                    <SelectTrigger aria-label={t('form_note_type')}>
                      <SelectValue placeholder={t('note_type_placeholder')} />
                    </SelectTrigger>
                    <SelectContent>
                      {(NOTE_TYPE_OPTIONS.includes(formData.note_type)
                        ? NOTE_TYPE_OPTIONS
                        : [formData.note_type, ...NOTE_TYPE_OPTIONS].filter(Boolean)
                      ).map((noteType) => (
                        <SelectItem key={noteType} value={noteType}>{noteType}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingRow>

                <div className="my-2 border-t border-border/40" />

                <TemplateEditorFieldManager
                  fields={formData.fields}
                  rules={fieldExtractionRules}
                  usedFields={usedFields}
                  onRemoveField={removeField}
                  onMoveField={moveField}
                  onRenameField={commitRenameField}
                  onToggleRequired={toggleFieldRequired}
                  notice={renameNotice}
                />
              </SettingsGroup>

              {/* 分组三：列表摘要兜底文本（可选） */}
              <SettingsGroup
                title={t('editor.summary_fallback_title')}
                description={t('editor.summary_fallback_desc')}
              >
                <SettingRow
                  title={t('editor.preview_front_label')}
                  controlClassName="[@container_(min-width:600px)]:w-[320px]"
                >
                  <Input
                    type="text"
                    aria-label={t('editor.preview_front_label')}
                    value={formData.preview_front}
                    onChange={(e) => setFormData({ ...formData, preview_front: e.target.value })}
                    placeholder={t('form_preview_front_placeholder') as string}
                  />
                </SettingRow>

                <SettingRow
                  title={t('editor.preview_back_label')}
                  controlClassName="[@container_(min-width:600px)]:w-[320px]"
                >
                  <Input
                    type="text"
                    aria-label={t('editor.preview_back_label')}
                    value={formData.preview_back}
                    onChange={(e) => setFormData({ ...formData, preview_back: e.target.value })}
                    placeholder={t('form_preview_back_placeholder') as string}
                  />
                </SettingRow>
              </SettingsGroup>
            </div>
          </ScrollArea>
        )}

        {/* 2. 模板代码（含样式） - 桌面分栏 / 移动端右屏 Portal */}
        {(activeTab === 'templates' || activeTab === 'styles') && (
          <div className="editor-content editor-content-code">
            {validationErrors.length > 0 && (
              <div className="flex-none px-4 pt-3">{renderValidationBanner()}</div>
            )}
            <div className="template-code-split-panel">
              {isSmallScreen ? (
                <>
                  <ScrollArea className="min-h-0 flex-1">
                    <div className="p-3">{renderPreviewPanel(true, true)}</div>
                  </ScrollArea>
                  {mobileEditorPortalTarget && createPortal(
                    <div className="flex h-full flex-col">
                      {renderCodeToolbar()}
                      <div className="relative min-h-0 flex-1 overflow-hidden">
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
                            highlightActiveLine: true,
                            foldGutter: true,
                            bracketMatching: true,
                            closeBrackets: true,
                            autocompletion: true,
                          }}
                        />
                      </div>
                      {renderCodeBottomNotices()}
                    </div>,
                    mobileEditorPortalTarget,
                  )}
                </>
              ) : (
                <HorizontalResizable
                  initial={0.55}
                  minLeft={0.35}
                  minRight={0.28}
                  className="h-full"
                  left={(
                    <div className="flex h-full w-full min-w-0 flex-col border-r border-border/30">
                      {renderCodeToolbar()}
                      <div ref={cmContainerRef} className="relative min-h-0 flex-1 overflow-hidden">
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
                      {renderCodeBottomNotices()}
                    </div>
                  )}
                  right={(
                    <div className="flex h-full w-full min-w-0 flex-col">
                      <ScrollArea className="min-h-0 flex-1">
                        <div className="p-4">{renderPreviewPanel(false, true)}</div>
                      </ScrollArea>
                    </div>
                  )}
                />
              )}
            </div>
          </div>
        )}

        {/* 3. 预览数据 - 桌面左右分屏（表单/JSON + 实时预览），移动端上下排布 */}
        {activeTab === 'data' && (
          isSmallScreen ? (
            <ScrollArea className="editor-content">
              <div className="space-y-5 p-4">
                {renderValidationBanner()}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <SegmentedControl<'form' | 'json'>
                    ariaLabel={t('editor.data_mode_aria')}
                    value={dataEditMode}
                    onValueChange={setDataEditMode}
                    options={dataModeOptions}
                    size="compact"
                  />
                  <DsButton type="button" variant="ghost" size="sm" onClick={copyJsonTemplate}>
                    <Copy size={14} aria-hidden="true" />
                    <span>{t('generate_template_json')}</span>
                  </DsButton>
                </div>

                {dataEditMode === 'form' && sampleDataLive !== null ? (
                  <SettingsGroup title={t('preview_data')} description={t('preview_data_desc')}>
                    {formData.fields.map((field) => (
                      <SettingRow key={field} title={field}>
                        <Input
                          type="text"
                          value={formatSampleValue(sampleDataLive[field])}
                          placeholder={tAnki('templateEditor.sampleValuePlaceholder') as string}
                          onChange={(e) => handleSampleTextInput(field, e.target.value)}
                        />
                      </SettingRow>
                    ))}
                  </SettingsGroup>
                ) : (
                  <div className="space-y-2">
                    <div className="overflow-hidden rounded-[var(--radius-shell-control)] border border-border/60">
                      <CodeMirror
                        value={previewDataJson}
                        onChange={(value) => setPreviewDataJson(value)}
                        extensions={jsonCmExtensions}
                        theme={cmTheme}
                        height="min(340px, 42dvh)"
                        placeholder="{}"
                        className="template-codemirror-editor"
                        basicSetup={{
                          lineNumbers: true,
                          highlightActiveLine: true,
                          bracketMatching: true,
                          closeBrackets: true,
                        }}
                      />
                    </div>
                    {!jsonValid && (
                      <Alert variant="destructive" className="py-2 text-xs">
                        {t('json_invalid')}
                      </Alert>
                    )}
                  </div>
                )}

                <div className="border-t border-border/40 pt-4">
                  {renderPreviewPanel(true, false)}
                </div>
              </div>
            </ScrollArea>
          ) : (
            <div className="editor-content editor-content-code">
              <HorizontalResizable
                initial={0.52}
                minLeft={0.35}
                minRight={0.3}
                className="h-full"
                left={(
                  <div className="flex h-full w-full min-w-0 flex-col border-r border-border/30">
                    {renderDataEditorBody()}
                  </div>
                )}
                right={(
                  <div className="flex h-full w-full min-w-0 flex-col">
                    <ScrollArea className="min-h-0 flex-1">
                      <div className="p-4">{renderPreviewPanel(false, false)}</div>
                    </ScrollArea>
                  </div>
                )}
              />
            </div>
          )
        )}

        {/* 4. 提取规则 */}
        {activeTab === 'rules' && (
          <ScrollArea className="editor-content">
            <div className="mx-auto w-full max-w-4xl space-y-6 px-5 py-6 sm:px-6 lg:px-8">
              {renderValidationBanner()}

              <SettingsGroup
                title={t('field_extraction_rules')}
                description={t('extraction_rules_desc')}
              >
                {formData.fields.length === 0 ? (
                  <p className="py-4 text-center text-sm text-muted-foreground">
                    {t('editor.no_fields_yet')}
                  </p>
                ) : (
                  <div className="divide-y divide-border/40">
                    {formData.fields.map((fieldName, index) => {
                      const rule = fieldExtractionRules[fieldName] ?? buildDefaultRule(fieldName);
                      const isUsed = usedFields.has(fieldName);
                      return (
                        <div key={fieldName} className="space-y-3 py-4 first:pt-1 last:pb-1">
                          {/* 字段头部：序号 + 字段名 + 引用态 + 必填开关 */}
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground/60">
                                {index + 1}
                              </span>
                              <span className="truncate font-mono text-sm font-semibold text-foreground">
                                {fieldName}
                              </span>
                              {isUsed && (
                                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap">
                                  <CheckCircle size={12} weight="fill" className="text-success shrink-0" aria-hidden="true" />
                                  <span>{tAnki('templateEditor.fieldUsed')}</span>
                                </span>
                              )}
                            </div>

                            <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted-foreground select-none">
                              <Switch
                                size="sm"
                                checked={rule.is_required}
                                onCheckedChange={(checked) => {
                                  setFieldExtractionRules((prev) => ({
                                    ...prev,
                                    [fieldName]: { ...rule, is_required: checked },
                                  }));
                                }}
                                aria-label={`${fieldName} ${t('is_required_label')}`}
                              />
                              <span className={cn(rule.is_required && 'font-medium text-foreground')}>
                                {rule.is_required ? t('required') : t('optional_label')}
                              </span>
                            </label>
                          </div>

                          {/* 规则控件：第 1 行 类型 + 默认值，第 2 行 提取说明 */}
                          <div className="grid grid-cols-1 gap-3 pl-0 sm:grid-cols-12 sm:pl-7">
                            <div className="space-y-1.5 sm:col-span-4">
                              <Label className="text-xs text-muted-foreground">
                                {t('field_type_label')}
                              </Label>
                              <Select
                                value={isFieldType(rule.field_type) ? rule.field_type : 'Text'}
                                onValueChange={(value) => {
                                  if (!isFieldType(value)) return;
                                  setFieldExtractionRules((prev) => ({
                                    ...prev,
                                    [fieldName]: { ...rule, field_type: value },
                                  }));
                                }}
                              >
                                <SelectTrigger aria-label={`${fieldName} ${t('field_type_label')}`}>
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

                            <div className="space-y-1.5 sm:col-span-8">
                              <Label className="text-xs text-muted-foreground">
                                {t('field_default_value')}
                              </Label>
                              <Input
                                type="text"
                                value={rule.default_value}
                                onChange={(e) => {
                                  setFieldExtractionRules((prev) => ({
                                    ...prev,
                                    [fieldName]: { ...rule, default_value: e.target.value },
                                  }));
                                }}
                                placeholder={rule.field_type === 'Array' ? '[]' : t('field_default_placeholder')}
                              />
                            </div>

                            <div className="space-y-1.5 sm:col-span-12">
                              <Label className="text-xs text-muted-foreground">
                                {t('field_description_label')}
                              </Label>
                              <Textarea
                                value={rule.description}
                                onChange={(e) => {
                                  setFieldExtractionRules((prev) => ({
                                    ...prev,
                                    [fieldName]: { ...rule, description: e.target.value },
                                  }));
                                }}
                                placeholder={t('field_purpose_placeholder')}
                                rows={2}
                                className="min-h-[60px]"
                              />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </SettingsGroup>
            </div>
          </ScrollArea>
        )}

        {/* 5. 高级设置 */}
        {activeTab === 'advanced' && (
          <ScrollArea className="editor-content">
            <div className="mx-auto w-full max-w-4xl space-y-6 px-5 py-6 sm:px-6 lg:px-8">
              {renderValidationBanner()}

              <SettingsGroup
                title={t('advanced_settings')}
                description={t('advanced_settings_desc')}
                actions={(
                  <DsButton
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowPromptPreview((prev) => !prev)}
                  >
                    {showPromptPreview
                      ? <EyeSlash size={15} aria-hidden="true" />
                      : <Eye size={15} aria-hidden="true" />}
                    <span>{showPromptPreview ? t('hide') : t('preview')}{t('full_prompt')}</span>
                  </DsButton>
                )}
              >
                <div className="space-y-2 px-1 py-2">
                  <Label className="text-sm font-medium text-foreground/90">
                    {t('core_requirements')}
                  </Label>
                  <Textarea
                    value={formData.generation_prompt}
                    onChange={(e) => setFormData({ ...formData, generation_prompt: e.target.value })}
                    placeholder={t('generation_prompt_placeholder') as string}
                    rows={10}
                  />
                  <p className="text-xs leading-relaxed text-muted-foreground/70">
                    {t('generation_prompt_hint')}
                  </p>
                </div>
              </SettingsGroup>

              {showPromptPreview && (
                <SettingsGroup
                  title={t('full_prompt_preview')}
                  description={t('full_prompt_preview_desc')}
                  actions={(
                    <DsButton
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleCopyFullPrompt()}
                    >
                      {promptCopied
                        ? <Check size={14} className="text-success" aria-hidden="true" />
                        : <Copy size={14} aria-hidden="true" />}
                      <span>{promptCopied ? t('editor.prompt_copied') : t('editor.copy_prompt')}</span>
                    </DsButton>
                  )}
                >
                  <ScrollArea className="max-h-[min(520px,55dvh)] rounded-[var(--radius-shell-control)] border border-border/50 bg-background/70">
                    <pre className="p-4 font-mono text-xs leading-relaxed text-foreground/90 whitespace-pre-wrap break-words select-text">
                      {fullPromptText}
                    </pre>
                  </ScrollArea>
                </SettingsGroup>
              )}
            </div>
          </ScrollArea>
        )}

        {/* 回退底部操作栏：仅当外层未接管操作时展示 */}
        {!hideFooter && (
          <div className="flex flex-none flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border/40 px-5 py-2.5">
            <div className="flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
              {isDirty && (
                <span className="inline-flex items-center gap-2 text-foreground" role="status">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" aria-hidden="true" />
                  <span>{tAnki('templateEditor.unsavedChanges')}</span>
                  <DsButton
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={discardChanges}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    {tAnki('templateEditor.discardChanges')}
                  </DsButton>
                </span>
              )}
              {!isDirty && mode === 'edit' && template && (
                <span className="truncate tabular-nums">
                  {t('created_at_label', { date: new Date(template.created_at).toLocaleDateString() })}
                  {' · '}
                  {t('updated_at_label', { date: new Date(template.updated_at).toLocaleDateString() })}
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <DsButton type="button" variant="ghost" size="sm" onClick={onCancel}>
                {t('cancel_button')}
              </DsButton>
              <DsButton
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void handleSubmit()}
                disabled={isSubmitting}
                className="bg-[color:var(--button-tonal-bg)] font-medium text-foreground"
              >
                {isSubmitting && <CircleNotch size={14} className="animate-spin" aria-hidden="true" />}
                <span>{mode === 'create' ? t('submit_create') : t('submit_save')}</span>
              </DsButton>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

MinimalTemplateEditor.displayName = 'MinimalTemplateEditor';

export default MinimalTemplateEditor;

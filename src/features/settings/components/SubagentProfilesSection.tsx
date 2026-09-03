import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowsClockwise,
  CaretDown,
  CircleNotch,
  FolderOpen,
  PencilSimple,
  Plus,
  Robot,
  Trash,
  WarningCircle,
} from '@phosphor-icons/react';

import { DsButton } from '@/components/ui/DsButton';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { getErrorMessage } from '@/utils/errorUtils';
import { cn } from '@/lib/utils';
import { inputShellClass } from '@/components/ui/shad/inputShell';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { SettingsGroup } from './settingsTabPrimitives';

/** 内建档案摘要（workspace_list_agent_profiles.builtin）。 */
interface BuiltinProfileSummary {
  id: string;
  description: string | null;
  model: string | null;
  toolCount: number;
}

/** 自定义档案文件摘要（含加载器会跳过的非法文件）。 */
interface CustomAgentFileSummary {
  fileName: string;
  bytes: number;
  modifiedAt: string | null;
  name: string | null;
  description: string | null;
  base: string | null;
  model: string | null;
  toolCount: number | null;
  valid: boolean;
  active: boolean;
}

interface ListAgentProfilesResponse {
  builtin: BuiltinProfileSummary[];
  customFiles: CustomAgentFileSummary[];
  agentsDir: string;
}

const isTauri =
  typeof window !== 'undefined' &&
  Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);

const BUILTIN_PROFILE_IDS = ['default', 'worker', 'explorer'] as const;

type BuiltinProfileId = (typeof BUILTIN_PROFILE_IDS)[number];

const isBuiltinProfileId = (id: string): id is BuiltinProfileId =>
  (BUILTIN_PROFILE_IDS as readonly string[]).includes(id);

const DELETE_CONFIRM_TIMEOUT_MS = 5_000;
const NAME_PATTERN = /^[a-z0-9-]+$/;
const MAX_NAME_CHARS = 64;
const UNSUPPORTED_RUNTIME_FIELDS = new Set([
  'permissions',
  'context_inheritance',
  'contextInheritance',
]);
const REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'x_high']);

// 控件壳统一走 inputShell 契约（边框/底色/圆角/字号/focus 与全域 Input/Select 一致）
const inputClassName = cn(inputShellClass, 'h-11 w-full sm:h-9 [@media(pointer:coarse)]:min-h-11');

/** 表单可编辑的结构化字段；无法结构化解析的文件退回原始文本编辑。 */
type ProfileDraft = {
  name: string;
  description: string;
  base: BuiltinProfileId;
  model: string;
  instructions: string;
  /** 其他 frontmatter 行（tools/skills/未知 key），保存时原样保留。 */
  extraLines: string;
};

type EditorInitial =
  | { kind: 'form'; draft: ProfileDraft }
  | { kind: 'raw'; content: string };

const emptyDraft = (): ProfileDraft => ({
  name: '',
  description: '',
  base: 'worker',
  model: '',
  instructions: '',
  extraLines: '',
});

/**
 * 把档案文件内容解析为结构化草稿；frontmatter 缺失/未闭合/base 非内建
 * 时返回 null（编辑器退回原始文本模式，避免表单静默丢字段）。
 */
const parseProfileContent = (content: string): ProfileDraft | null => {
  const lines = content.split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== '---') return null;

  const known: Partial<Record<'name' | 'description' | 'base' | 'model', string>> = {};
  const extras: string[] = [];
  let closeIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '---') {
      closeIndex = i;
      break;
    }
    const separator = line.indexOf(':');
    if (separator === -1) {
      if (line.trim()) extras.push(line);
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === 'name' || key === 'description' || key === 'base' || key === 'model') {
      known[key] = value;
    } else {
      extras.push(line);
    }
  }
  if (closeIndex === -1) return null;

  const base = known.base || 'worker';
  if (!isBuiltinProfileId(base)) return null;

  return {
    name: known.name ?? '',
    description: known.description ?? '',
    base,
    model: known.model ?? '',
    instructions: lines.slice(closeIndex + 1).join('\n').trim(),
    extraLines: extras.join('\n'),
  };
};

/** 表单已有专属字段的保留键：高级字段里出现时丢弃，避免静默覆盖表单值。 */
const RESERVED_FRONTMATTER_KEYS = new Set(['name', 'description', 'base', 'model']);

const isReservedExtraLine = (line: string): boolean => {
  const separator = line.indexOf(':');
  return separator !== -1 && RESERVED_FRONTMATTER_KEYS.has(line.slice(0, separator).trim());
};

const serializeDraft = (draft: ProfileDraft): string => {
  const lines = ['---', `name: ${draft.name.trim()}`];
  if (draft.description.trim()) lines.push(`description: ${draft.description.trim()}`);
  lines.push(`base: ${draft.base}`);
  if (draft.model.trim()) lines.push(`model: ${draft.model.trim()}`);
  for (const extra of draft.extraLines.split(/\r?\n/)) {
    if (extra.trim() && !isReservedExtraLine(extra)) lines.push(extra);
  }
  lines.push('---');
  const body = draft.instructions.trim();
  if (body) lines.push(body);
  return `${lines.join('\n')}\n`;
};

const formatBytes = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;

/** 后端错误码 → i18n key；非错误码的技术错误原样展示。 */
const PROFILE_ERROR_KEYS: Record<string, string> = {
  PROFILE_FILE_EXISTS: 'settings:subagentProfiles.errors.file_exists',
  PROFILE_FILE_NOT_FOUND: 'settings:subagentProfiles.errors.not_found',
};

interface ProfileFormProps {
  mode: 'create' | 'edit';
  idPrefix: string;
  initial: EditorInitial;
  /** Resolves to an inline error message, or null on success. */
  onSubmit: (content: string) => Promise<string | null>;
  onCancel: () => void;
}

const ProfileForm: React.FC<ProfileFormProps> = ({
  mode,
  idPrefix,
  initial,
  onSubmit,
  onCancel,
}) => {
  const { t } = useTranslation(['settings', 'common']);
  const [draft, setDraft] = useState<ProfileDraft>(
    initial.kind === 'form' ? initial.draft : emptyDraft(),
  );
  const [rawContent, setRawContent] = useState<string>(
    initial.kind === 'raw' ? initial.content : '',
  );
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  const patch = (partial: Partial<ProfileDraft>) =>
    setDraft((current) => ({ ...current, ...partial }));

  const validate = (): string | null => {
    if (initial.kind === 'raw') {
      if (!rawContent.trim()) return t('settings:subagentProfiles.errors.content_required');
      return null;
    }
    const name = draft.name.trim();
    if (!name) return t('settings:subagentProfiles.errors.name_required');
    if (name.length > MAX_NAME_CHARS || !NAME_PATTERN.test(name)) {
      return t('settings:subagentProfiles.errors.name_invalid');
    }
    if (isBuiltinProfileId(name)) {
      return t('settings:subagentProfiles.errors.name_builtin_conflict');
    }
    for (const line of draft.extraLines.split(/\r?\n/)) {
      const separator = line.indexOf(':');
      if (separator === -1) continue;
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
      if (UNSUPPORTED_RUNTIME_FIELDS.has(key)) {
        return t('settings:subagentProfiles.errors.unsupported_runtime_field', { field: key });
      }
      if ((key === 'reasoning_effort' || key === 'reasoningEffort') && !REASONING_EFFORTS.has(value)) {
        return t('settings:subagentProfiles.errors.reasoning_effort_invalid');
      }
    }
    return null;
  };

  const handleSubmit = async () => {
    const validationError = validate();
    if (validationError) {
      setFormError(validationError);
      return;
    }
    setSaving(true);
    setFormError(null);
    const content = initial.kind === 'raw' ? rawContent : serializeDraft(draft);
    const error = await onSubmit(content);
    if (!mountedRef.current) return;
    setSaving(false);
    if (error) setFormError(error);
  };

  return (
    <div className="space-y-4 px-3 py-4 sm:px-4" data-testid={`subagent-profile-form-${mode}`}>
      {initial.kind === 'raw' ? (
        <div className="block space-y-1.5 text-sm">
          <label htmlFor={`${idPrefix}-raw`} className="block font-medium text-foreground">
            {t('settings:subagentProfiles.form.raw_title')}
          </label>
          <p className="text-xs text-muted-foreground">
            {t('settings:subagentProfiles.form.raw_hint')}
          </p>
          <textarea
            id={`${idPrefix}-raw`}
            className={cn(inputShellClass, 'w-full scroll-area--native h-56 sm:h-56 resize-y py-2 font-mono text-xs leading-5')}
            value={rawContent}
            spellCheck={false}
            onChange={(event) => setRawContent(event.target.value)}
            disabled={saving}
          />
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium text-foreground">
                {t('settings:subagentProfiles.form.name')}
              </span>
              <input
                className={inputClassName}
                maxLength={MAX_NAME_CHARS}
                value={draft.name}
                placeholder={t('settings:subagentProfiles.form.name_placeholder')}
                onChange={(event) => patch({ name: event.target.value })}
                disabled={saving}
              />
              <span className="block text-xs text-muted-foreground">
                {t('settings:subagentProfiles.form.name_hint')}
              </span>
            </label>
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium text-foreground">
                {t('settings:subagentProfiles.form.base')}
              </span>
              <select
                className={inputClassName}
                value={draft.base}
                onChange={(event) => patch({ base: event.target.value as BuiltinProfileId })}
                disabled={saving}
              >
                {BUILTIN_PROFILE_IDS.map((id) => (
                  <option key={id} value={id}>
                    {t(`settings:subagentProfiles.builtin_names.${id}`)} ({id})
                  </option>
                ))}
              </select>
              <span className="block text-xs text-muted-foreground">
                {t('settings:subagentProfiles.form.base_hint')}
              </span>
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium text-foreground">
                {t('settings:subagentProfiles.form.description')}
              </span>
              <input
                className={inputClassName}
                value={draft.description}
                placeholder={t('settings:subagentProfiles.form.description_placeholder')}
                onChange={(event) => patch({ description: event.target.value })}
                disabled={saving}
              />
            </label>
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium text-foreground">
                {t('settings:subagentProfiles.form.model')}
              </span>
              <input
                className={inputClassName}
                value={draft.model}
                placeholder={t('settings:subagentProfiles.form.model_placeholder')}
                onChange={(event) => patch({ model: event.target.value })}
                disabled={saving}
              />
              <span className="block text-xs text-muted-foreground">
                {t('settings:subagentProfiles.form.model_hint')}
              </span>
            </label>
          </div>

          <div className="block space-y-1.5 text-sm">
            <label htmlFor={`${idPrefix}-instructions`} className="block font-medium text-foreground">
              {t('settings:subagentProfiles.form.instructions')}
            </label>
            <textarea
              id={`${idPrefix}-instructions`}
              className={cn(inputShellClass, 'w-full scroll-area--native h-36 sm:h-36 resize-y py-2 leading-5')}
              value={draft.instructions}
              placeholder={t('settings:subagentProfiles.form.instructions_placeholder')}
              onChange={(event) => patch({ instructions: event.target.value })}
              disabled={saving}
            />
            <span className="block text-xs text-muted-foreground">
              {t('settings:subagentProfiles.form.instructions_hint')}
            </span>
          </div>

          <details className="group rounded-md border border-[color:var(--border-soft)]" open={Boolean(draft.extraLines.trim())}>
            <summary className="flex cursor-pointer select-none items-center gap-1.5 px-3 py-2 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground [@media(pointer:coarse)]:min-h-11">
              <CaretDown className="h-3.5 w-3.5 transition-transform duration-150 group-open:rotate-180 motion-reduce:transition-none" aria-hidden="true" />
              {t('settings:subagentProfiles.form.advanced')}
            </summary>
            <div className="space-y-1.5 px-3 pb-3 pt-1 text-sm">
              <p className="text-xs text-muted-foreground">
                {t('settings:subagentProfiles.form.advanced_hint')}
              </p>
              <textarea
                aria-label={t('settings:subagentProfiles.form.advanced')}
                className={cn(inputShellClass, 'w-full scroll-area--native h-20 sm:h-20 resize-y py-2 font-mono text-xs leading-5')}
                value={draft.extraLines}
                spellCheck={false}
                placeholder={'reasoning_effort: high\ntools: [builtin-web_search]\nskills: [research]'}
                onChange={(event) => patch({ extraLines: event.target.value })}
                disabled={saving}
              />
            </div>
          </details>
        </>
      )}

      {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}

      <div className="flex items-center justify-end gap-2 border-t border-[color:var(--border-soft)] pt-3">
        <DsButton variant="ghost" size="sm" className="min-h-11 sm:min-h-0 [@media(pointer:coarse)]:!min-h-11" disabled={saving} onClick={onCancel}>
          {t('common:cancel')}
        </DsButton>
        <DsButton variant="primary" size="sm" className="min-h-11 sm:min-h-0 [@media(pointer:coarse)]:!min-h-11" disabled={saving} onClick={() => void handleSubmit()}>
          {saving && <CircleNotch className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {mode === 'create'
            ? t('settings:subagentProfiles.form.create_submit')
            : t('common:save')}
        </DsButton>
      </div>
    </div>
  );
};

export const SubagentProfilesSection: React.FC = () => {
  const { t, i18n } = useTranslation(['settings', 'common']);
  const { isSmallScreen } = useBreakpoint();
  const [loading, setLoading] = useState<boolean>(isTauri);
  const [error, setError] = useState<string | null>(null);
  const [builtin, setBuiltin] = useState<BuiltinProfileSummary[]>([]);
  const [customFiles, setCustomFiles] = useState<CustomAgentFileSummary[]>([]);
  const [agentsDir, setAgentsDir] = useState<string>('');
  /** 'create' 或自定义档案 fileName；同一时刻只展开一个编辑面板。 */
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** 编辑面板初始内容（读取文件后填充）。 */
  const [editorInitial, setEditorInitial] = useState<EditorInitial | null>(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const [confirmingDeleteFile, setConfirmingDeleteFile] = useState<string | null>(null);
  const [deletingFile, setDeletingFile] = useState<string | null>(null);
  /** openEdit 时序守卫：快速切换行时丢弃过期的文件读取结果，防止内容串行覆盖。 */
  const openEditSeqRef = useRef(0);

  const load = useCallback(async () => {
    if (!isTauri) return;
    setLoading(true);
    setError(null);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const response = await invoke<ListAgentProfilesResponse>('workspace_list_agent_profiles');
      setBuiltin(response.builtin);
      setCustomFiles(response.customFiles);
      setAgentsDir(response.agentsDir);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!confirmingDeleteFile) return;
    const timer = window.setTimeout(() => setConfirmingDeleteFile(null), DELETE_CONFIRM_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [confirmingDeleteFile]);

  const localizeCommandError = useCallback((cause: unknown): string => {
    const message = getErrorMessage(cause);
    const key = PROFILE_ERROR_KEYS[message.trim()];
    return key ? t(key) : message;
  }, [t]);

  const handleOpenDir = useCallback(async () => {
    if (!agentsDir) return;
    try {
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
      await revealItemInDir(agentsDir);
    } catch (e) {
      console.error('[SubagentProfilesSection] Failed to reveal agents dir:', e);
      showGlobalNotification('error', t('settings:subagentProfiles.errors.reveal_failed'));
    }
  }, [agentsDir, t]);

  const closeEditor = useCallback(() => {
    openEditSeqRef.current += 1;
    setExpandedId(null);
    setEditorInitial(null);
    setEditorLoading(false);
  }, []);

  const openCreate = useCallback(() => {
    openEditSeqRef.current += 1;
    setConfirmingDeleteFile(null);
    setEditorInitial({ kind: 'form', draft: emptyDraft() });
    setExpandedId('create');
  }, []);

  const openEdit = useCallback(async (fileName: string) => {
    const seq = ++openEditSeqRef.current;
    setConfirmingDeleteFile(null);
    setExpandedId(fileName);
    setEditorInitial(null);
    setEditorLoading(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const response = await invoke<{ fileName: string; content: string }>(
        'workspace_read_agent_profile_file',
        { fileName },
      );
      if (seq !== openEditSeqRef.current) return;
      const draft = parseProfileContent(response.content);
      setEditorInitial(draft ? { kind: 'form', draft } : { kind: 'raw', content: response.content });
    } catch (e) {
      if (seq !== openEditSeqRef.current) return;
      showGlobalNotification('error', localizeCommandError(e));
      setExpandedId(null);
    } finally {
      if (seq === openEditSeqRef.current) setEditorLoading(false);
    }
  }, [localizeCommandError]);

  const saveProfile = useCallback(async (
    fileName: string,
    content: string,
    overwrite: boolean,
  ): Promise<string | null> => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const saved = await invoke<{
        fileName: string;
        agentName: string;
        bytes: number;
        warnings?: Array<{ code?: string; message?: string }>;
      }>(
        'workspace_save_agent_profile_file',
        { fileName, content, overwrite },
      );
      closeEditor();
      showGlobalNotification(
        'success',
        t(
          overwrite
            ? 'settings:subagentProfiles.notices.updated'
            : 'settings:subagentProfiles.notices.created',
          { name: saved.agentName },
        ),
      );
      for (const warning of saved.warnings ?? []) {
        showGlobalNotification(
          'warning',
          warning.message || t('settings:subagentProfiles.errors.model_catalog_unavailable'),
        );
      }
      await load();
      return null;
    } catch (e) {
      return localizeCommandError(e);
    }
  }, [closeEditor, load, localizeCommandError, t]);

  const handleCreateSubmit = useCallback(async (content: string): Promise<string | null> => {
    // 新建时文件名跟随 name（与档案 id 一致，便于目录里按名定位）
    const draft = parseProfileContent(content);
    const stem = draft?.name.trim();
    if (!stem || !NAME_PATTERN.test(stem)) {
      return t('settings:subagentProfiles.errors.name_invalid');
    }
    return saveProfile(`${stem}.md`, content, false);
  }, [saveProfile, t]);

  const handleConfirmDelete = useCallback(async (fileName: string) => {
    setConfirmingDeleteFile(null);
    setDeletingFile(fileName);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('workspace_delete_agent_profile_file', { fileName });
      if (expandedId === fileName) closeEditor();
      showGlobalNotification(
        'success',
        t('settings:subagentProfiles.notices.deleted', { fileName }),
      );
      await load();
    } catch (e) {
      showGlobalNotification('error', localizeCommandError(e));
    } finally {
      setDeletingFile(null);
    }
  }, [closeEditor, expandedId, load, localizeCommandError, t]);

  const builtinDisplayName = (id: string): string =>
    isBuiltinProfileId(id) ? t(`settings:subagentProfiles.builtin_names.${id}`) : id;

  const formatModified = (value: string | null): string | null => {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const locale = i18n.resolvedLanguage || i18n.language || 'zh-CN';
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  };

  const renderBuiltinRow = (profile: BuiltinProfileSummary) => (
    <div
      key={profile.id}
      className="flex items-start justify-between gap-3 rounded-[var(--radius-shell-row,0.5rem)] px-3 py-2.5"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">
            {builtinDisplayName(profile.id)}
          </span>
          <code className="text-xs text-muted-foreground/70">{profile.id}</code>
          <span className="rounded-full border border-border/60 bg-muted/40 px-1.5 py-0.5 text-2xs leading-none text-muted-foreground">
            {t('settings:subagentProfiles.builtin_badge')}
          </span>
        </div>
        {profile.description && (
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground/80">
            {profile.description}
          </p>
        )}
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground/70">
          {profile.model && (
            <span>{t('settings:subagentProfiles.model', { model: profile.model })}</span>
          )}
          <span>{t('settings:subagentProfiles.tool_count', { count: profile.toolCount })}</span>
        </p>
      </div>
    </div>
  );

  const renderCustomRow = (file: CustomAgentFileSummary) => {
    const expanded = expandedId === file.fileName;
    const confirmingDelete = confirmingDeleteFile === file.fileName;
    const deleteBusy = deletingFile === file.fileName;
    const displayName = file.name || file.fileName.replace(/\.md$/i, '');
    const modified = formatModified(file.modifiedAt);

    return (
      <div
        key={file.fileName}
        className={cn(
          'overflow-hidden rounded-[var(--radius-shell-row,0.5rem)] border transition-colors duration-150',
          expanded
            ? 'border-[color:var(--border-soft)] bg-muted/30'
            : 'border-transparent hover:bg-muted/30',
        )}
        data-testid={`subagent-profile-row-${file.fileName}`}
      >
        {confirmingDelete && (
          <div className="ui-fade-in flex flex-wrap items-center justify-between gap-2 border-b border-destructive/20 bg-destructive/10 px-3 py-2">
            <span className="text-xs font-medium text-destructive">
              {t('settings:subagentProfiles.delete.inline_confirm')}
            </span>
            <div className="flex items-center gap-2">
              <DsButton size="sm" variant="ghost" className="min-h-11 sm:min-h-0 [@media(pointer:coarse)]:!min-h-11" onClick={() => setConfirmingDeleteFile(null)}>
                {t('common:cancel')}
              </DsButton>
              <DsButton
                size="sm"
                variant="danger"
                disabled={deleteBusy}
                onClick={() => void handleConfirmDelete(file.fileName)}
                className="min-h-11 sm:min-h-0 [@media(pointer:coarse)]:!min-h-11"
              >
                {deleteBusy && <CircleNotch className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                {t('settings:subagentProfiles.delete.confirm')}
              </DsButton>
            </div>
          </div>
        )}

        {/* 点击行主体展开/收起编辑；键盘用户通过铅笔按钮（aria-expanded）操作。 */}
        <div
          className="group flex w-full cursor-pointer flex-wrap items-center gap-3 px-3 py-2.5 text-left sm:flex-nowrap [@media(pointer:coarse)]:min-h-11"
          onClick={() => (expanded ? closeEditor() : void openEdit(file.fileName))}
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 truncate text-sm font-medium text-foreground" title={displayName}>
                {displayName}
              </span>
              <span className="rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-2xs leading-none text-primary">
                {t('settings:subagentProfiles.custom_badge')}
              </span>
              {!file.valid && (
                <span className="flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-2xs leading-none text-warning">
                  <WarningCircle className="h-3 w-3" aria-hidden="true" />
                  {t('settings:subagentProfiles.invalid_badge')}
                </span>
              )}
              {file.valid && !file.active && (
                <span className="rounded-full border border-border/60 bg-muted/40 px-1.5 py-0.5 text-2xs leading-none text-muted-foreground">
                  {t('settings:subagentProfiles.inactive_badge')}
                </span>
              )}
            </div>
            {file.description && (
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground/80">
                {file.description}
              </p>
            )}
            {!file.valid && (
              <p className="mt-0.5 text-xs leading-relaxed text-warning">
                {t('settings:subagentProfiles.invalid_hint')}
              </p>
            )}
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground/70">
              <span className="font-mono">{file.fileName}</span>
              <span>{formatBytes(file.bytes)}</span>
              {file.model && (
                <span>{t('settings:subagentProfiles.model', { model: file.model })}</span>
              )}
              {file.toolCount !== null && (
                <span>{t('settings:subagentProfiles.tool_count', { count: file.toolCount })}</span>
              )}
              {modified && <span>{t('settings:subagentProfiles.modified_at', { time: modified })}</span>}
            </p>
          </div>

          <div
            className="flex w-full shrink-0 items-center justify-end gap-1.5 sm:w-auto"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              className={cn('!h-7 !w-7 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11', expanded && 'bg-primary/10 text-primary')}
              aria-label={t('settings:subagentProfiles.actions.edit', { name: displayName })}
              aria-expanded={expanded}
              title={t('settings:subagentProfiles.actions.edit_short')}
              onClick={() => (expanded ? closeEditor() : void openEdit(file.fileName))}
            >
              <PencilSimple className="h-4 w-4" />
            </DsButton>
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              className="!h-7 !w-7 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11 text-destructive hover:text-destructive"
              aria-label={t('settings:subagentProfiles.actions.delete', { name: displayName })}
              title={t('settings:subagentProfiles.actions.delete_short')}
              disabled={deleteBusy}
              onClick={() => setConfirmingDeleteFile(file.fileName)}
            >
              {deleteBusy
                ? <CircleNotch className="h-4 w-4 animate-spin" />
                : <Trash className="h-4 w-4" />}
            </DsButton>
          </div>
        </div>

        {expanded && (
          <div className="ui-fade-in border-t border-[color:var(--border-soft)] bg-muted/20">
            {editorLoading || !editorInitial ? (
              <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
                <CircleNotch className="h-4 w-4 animate-spin" aria-hidden="true" />
                {t('settings:subagentProfiles.loading_file')}
              </div>
            ) : (
              <ProfileForm
                mode="edit"
                idPrefix={`edit-${file.fileName}`}
                initial={editorInitial}
                onSubmit={(content) => saveProfile(file.fileName, content, true)}
                onCancel={closeEditor}
              />
            )}
          </div>
        )}
      </div>
    );
  };

  const headerActions = (
    <>
      <DsButton
        variant="ghost"
        size="icon"
        iconOnly
        aria-label={t('settings:subagentProfiles.actions.refresh')}
        title={t('settings:subagentProfiles.actions.refresh')}
        disabled={loading}
        onClick={() => void load()}
        className="max-lg:!h-11 max-lg:!w-11 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
      >
        <ArrowsClockwise className={cn('h-4 w-4', loading && 'animate-spin')} />
      </DsButton>
      <DsButton
        variant="ghost"
        size="icon"
        iconOnly
        aria-label={t('settings:subagentProfiles.actions.open_dir')}
        title={t('settings:subagentProfiles.actions.open_dir')}
        disabled={!agentsDir}
        onClick={() => void handleOpenDir()}
        className="max-lg:!h-11 max-lg:!w-11 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
      >
        <FolderOpen className="h-4 w-4" aria-hidden="true" />
      </DsButton>
      {/* 移动端去纯色按钮：描边+主色文字，与供应商/模型页语言一致；桌面保持实心 primary */}
      <DsButton
        variant={isSmallScreen ? 'outline' : 'primary'}
        size="sm"
        disabled={!isTauri || expandedId === 'create'}
        onClick={openCreate}
        className={cn('max-lg:min-h-11 [@media(pointer:coarse)]:!min-h-11', isSmallScreen && 'text-primary')}
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        {t('settings:subagentProfiles.actions.create')}
      </DsButton>
    </>
  );

  return (
    <SettingsGroup
      title={t('settings:subagentProfiles.title')}
      description={t('settings:subagentProfiles.description')}
      actions={headerActions}
    >
      {!isTauri ? (
        <p className="rounded-2xl bg-muted px-4 py-6 text-sm text-muted-foreground">
          {t('settings:subagentProfiles.errors.desktop_only')}
        </p>
      ) : error ? (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive"
        >
          <span className="flex min-w-0 items-start gap-2">
            <WarningCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="break-words">{error}</span>
          </span>
          <DsButton variant="outline" size="sm" className="min-h-11 sm:min-h-0 [@media(pointer:coarse)]:!min-h-11" onClick={() => void load()}>
            {t('settings:subagentProfiles.actions.retry')}
          </DsButton>
        </div>
      ) : loading && builtin.length === 0 ? (
        <div aria-label={t('settings:subagentProfiles.loading')} className="space-y-1">
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              className="flex min-h-14 animate-pulse items-center gap-4 rounded-[var(--radius-shell-row,0.5rem)] px-3 py-3"
            >
              <div className="flex-1 space-y-2">
                <div className="h-4 w-40 max-w-full rounded bg-muted" />
                <div className="h-3 w-64 max-w-full rounded bg-muted" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {expandedId === 'create' && editorInitial && (
            <div className="ui-fade-in overflow-hidden rounded-[var(--radius-shell-row,0.5rem)] border border-[color:var(--border-soft)] bg-muted/20">
              <div className="border-b border-[color:var(--border-soft)] px-3 py-2.5 sm:px-4">
                <h3 className="text-sm font-semibold text-foreground">
                  {t('settings:subagentProfiles.form.create_title')}
                </h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t('settings:subagentProfiles.form.create_description')}
                </p>
              </div>
              <ProfileForm
                mode="create"
                idPrefix="create-subagent-profile"
                initial={editorInitial}
                onSubmit={handleCreateSubmit}
                onCancel={closeEditor}
              />
            </div>
          )}

          <div className="space-y-1">
            {builtin.map(renderBuiltinRow)}
            {customFiles.map(renderCustomRow)}
          </div>

          {customFiles.length === 0 && expandedId !== 'create' && (
            <div className="rounded-2xl bg-muted px-4 py-6">
              <Robot className="h-7 w-7 text-muted-foreground" aria-hidden="true" />
              <h3 className="mt-3 text-sm font-medium text-foreground">
                {t('settings:subagentProfiles.empty.title')}
              </h3>
              <p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">
                {t('settings:subagentProfiles.empty.description')}
              </p>
              <DsButton variant="primary" size="sm" className="mt-4 [@media(pointer:coarse)]:!min-h-11" onClick={openCreate}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t('settings:subagentProfiles.empty.cta')}
              </DsButton>
            </div>
          )}
        </div>
      )}
    </SettingsGroup>
  );
};

export default SubagentProfilesSection;

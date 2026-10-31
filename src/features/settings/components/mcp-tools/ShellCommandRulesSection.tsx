import { useMemo, useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { saveSetting } from '@/utils/settingsApi';
import { Plus, Trash, PencilSimple, CodeBlock, Lock, Warning, MagnifyingGlass } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { Switch } from '@/components/ui/shad/Switch';
import { Input } from '@/components/ui/shad/Input';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/shad/Select';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import {
  assessShellCommandRuleRisk,
  filterShellCommandRules,
  parseShellCommandPolicy,
  previewShellCommandPolicy,
  serializeShellCommandPolicy,
  SHELL_COMMAND_POLICY_SETTING_KEYS,
  validateShellCommandPattern,
  type ShellCommandAction,
  type ShellCommandMatchType,
  type ShellCommandRule,
} from '../toolPermissionModel';
import { TECHNICAL_INPUT_PROPS } from '@/components/ui/shad/technicalInputProps';
import { useAppConfirm } from './useAppConfirm';

const EMPTY_SHELL_RULE_DRAFT = {
  action: 'ask' as ShellCommandAction,
  matchType: 'exact' as ShellCommandMatchType,
  pattern: '',
  note: '',
};

const SHELL_EFFECT_RESTRICTIVENESS: Record<ShellCommandAction, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

function shellRuleRemovalRelaxesPolicy(
  rule: ShellCommandRule,
  defaultEffect: ShellCommandAction,
  nextRules: ShellCommandRule[]
): boolean {
  if (!rule.enabled || rule.action === 'allow') return false;
  const nextEffect = previewShellCommandPolicy(rule.pattern, defaultEffect, nextRules).effect;
  return SHELL_EFFECT_RESTRICTIVENESS[nextEffect] < SHELL_EFFECT_RESTRICTIVENESS[rule.action];
}

/** Fine-grained policy for the protected local terminal tool. */
export function ShellCommandRulesSection() {
  const { t } = useTranslation(['settings', 'common']);
  const [defaultEffect, setDefaultEffect] = useState<ShellCommandAction>('ask');
  const [rules, setRules] = useState<ShellCommandRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [actionFilter, setActionFilter] = useState<ShellCommandAction | 'all'>('all');
  const [typeFilter, setTypeFilter] = useState<ShellCommandMatchType | 'all'>('all');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [draft, setDraft] = useState(EMPTY_SHELL_RULE_DRAFT);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [pendingRisk, setPendingRisk] = useState<string | null>(null);
  const [pendingDefaultAllow, setPendingDefaultAllow] = useState(false);
  const [selectedRuleIds, setSelectedRuleIds] = useState<Set<string>>(new Set());
  const [previewCommand, setPreviewCommand] = useState('');
  const { appConfirm, confirmDialog } = useAppConfirm();

  const loadPolicy = useCallback(async () => {
    setLoading(true);
    try {
      const raw = await invoke<string>('get_setting', {
        key: SHELL_COMMAND_POLICY_SETTING_KEYS.policy,
      }).catch(() => '');
      const policy = parseShellCommandPolicy(raw);
      setDefaultEffect(policy.defaultEffect);
      setRules(policy.rules);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadPolicy(); }, [loadPolicy]);

  const persistPolicy = useCallback(async (
    nextDefault: ShellCommandAction,
    nextRules: ShellCommandRule[]
  ) => {
    setSaving(true);
    try {
      await saveSetting(SHELL_COMMAND_POLICY_SETTING_KEYS.policy, serializeShellCommandPolicy(nextDefault, nextRules));
      setDefaultEffect(nextDefault);
      setRules(nextRules);
      showGlobalNotification('success', t('settings:tool_permissions.shell_rules.saved'));
      return true;
    } catch (error) {
      console.error('[ToolPermissions] Save shell command policy failed:', error);
      showGlobalNotification('error', t('settings:tool_permissions.shell_rules.save_failed'));
      return false;
    } finally {
      setSaving(false);
    }
  }, [t]);

  const handleDefaultEffect = useCallback(async (effect: ShellCommandAction) => {
    if (effect === 'allow' && !pendingDefaultAllow) {
      setPendingDefaultAllow(true);
      return;
    }
    if (await persistPolicy(effect, rules)) setPendingDefaultAllow(false);
  }, [pendingDefaultAllow, persistPolicy, rules]);

  const beginAdd = useCallback(() => {
    setEditingId(null);
    setDraft(EMPTY_SHELL_RULE_DRAFT);
    setDraftError(null);
    setPendingRisk(null);
    setShowEditor(true);
  }, []);

  const beginEdit = useCallback((rule: ShellCommandRule) => {
    setEditingId(rule.id);
    setDraft({
      action: rule.action,
      matchType: rule.matchType,
      pattern: rule.pattern,
      note: rule.note ?? '',
    });
    setDraftError(null);
    setPendingRisk(null);
    setShowEditor(true);
  }, []);

  const saveDraft = useCallback(async () => {
    const validationError = validateShellCommandPattern(draft.pattern, draft.matchType);
    if (validationError) {
      setDraftError(validationError);
      return;
    }
    const duplicate = rules.some(rule => rule.id !== editingId
      && rule.matchType === draft.matchType
      && rule.pattern.toLocaleLowerCase() === draft.pattern.trim().toLocaleLowerCase());
    if (duplicate) {
      setDraftError('duplicate');
      return;
    }
    const candidate: ShellCommandRule = {
      id: editingId ?? `shell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      action: draft.action,
      matchType: draft.matchType,
      pattern: draft.pattern.trim(),
      enabled: editingId ? rules.find(rule => rule.id === editingId)?.enabled !== false : true,
      ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
    };
    const risk = assessShellCommandRuleRisk(candidate);
    const riskFingerprint = `${candidate.action}:${candidate.matchType}:${candidate.pattern}`;
    if (risk && pendingRisk !== riskFingerprint) {
      setPendingRisk(riskFingerprint);
      return;
    }
    const next = editingId
      ? rules.map(rule => rule.id === editingId ? candidate : rule)
      : [...rules, candidate];
    if (await persistPolicy(defaultEffect, next)) {
      setShowEditor(false);
      setEditingId(null);
      setPendingRisk(null);
    }
  }, [defaultEffect, draft, editingId, pendingRisk, persistPolicy, rules]);

  const filteredRules = useMemo(() => filterShellCommandRules(rules, {
    query,
    action: actionFilter,
    matchType: typeFilter,
  }), [actionFilter, query, rules, typeFilter]);
  const preview = useMemo(() => previewCommand.trim()
    ? previewShellCommandPolicy(previewCommand, defaultEffect, rules)
    : null, [defaultEffect, previewCommand, rules]);
  const allVisibleSelected = filteredRules.length > 0
    && filteredRules.every(rule => selectedRuleIds.has(rule.id));

  useEffect(() => {
    const validIds = new Set(rules.map(rule => rule.id));
    setSelectedRuleIds(previous => new Set(
      Array.from(previous).filter(id => validIds.has(id))
    ));
  }, [rules]);

  useEffect(() => {
    setSelectedRuleIds(new Set());
  }, [actionFilter, query, typeFilter]);

  const selectVisibleRules = useCallback((selected: boolean) => {
    setSelectedRuleIds(previous => {
      const next = new Set(previous);
      for (const rule of filteredRules) {
        if (selected) next.add(rule.id);
        else next.delete(rule.id);
      }
      return next;
    });
  }, [filteredRules]);

  const updateSelectedRules = useCallback(async (operation: 'enable' | 'disable' | 'delete') => {
    if (selectedRuleIds.size === 0) return;
    const next = operation === 'delete'
      ? rules.filter(rule => !selectedRuleIds.has(rule.id))
      : rules.map(rule => selectedRuleIds.has(rule.id)
        ? { ...rule, enabled: operation === 'enable' }
        : rule);
    const relaxedCount = operation === 'enable' ? 0 : rules.filter(rule => (
      selectedRuleIds.has(rule.id) && shellRuleRemovalRelaxesPolicy(rule, defaultEffect, next)
    )).length;
    if (relaxedCount > 0 && !(await appConfirm(t('settings:tool_permissions.shell_rules.relax_confirm', { count: relaxedCount })))) return;
    if (operation === 'delete' && relaxedCount === 0 && !(await appConfirm(t('settings:tool_permissions.shell_rules.bulk_delete_confirm', { count: selectedRuleIds.size })))) return;
    if (await persistPolicy(defaultEffect, next)) setSelectedRuleIds(new Set());
  }, [appConfirm, defaultEffect, persistPolicy, rules, selectedRuleIds, t]);

  const setRuleEnabled = useCallback(async (rule: ShellCommandRule, enabled: boolean) => {
    const next = rules.map(item => item.id === rule.id ? { ...item, enabled } : item);
    if (!enabled && shellRuleRemovalRelaxesPolicy(rule, defaultEffect, next)) {
      if (!(await appConfirm(t('settings:tool_permissions.shell_rules.relax_confirm', { count: 1 })))) return;
    }
    await persistPolicy(defaultEffect, next);
  }, [appConfirm, defaultEffect, persistPolicy, rules, t]);

  const deleteRule = useCallback(async (rule: ShellCommandRule) => {
    const next = rules.filter(item => item.id !== rule.id);
    const key = shellRuleRemovalRelaxesPolicy(rule, defaultEffect, next)
      ? 'settings:tool_permissions.shell_rules.relax_confirm'
      : 'settings:tool_permissions.shell_rules.delete_confirm';
    if (!(await appConfirm(t(key, { count: 1, pattern: rule.pattern })))) return;
    await persistPolicy(defaultEffect, next);
  }, [appConfirm, defaultEffect, persistPolicy, rules, t]);

  const actionClass: Record<ShellCommandAction, string> = {
    allow: 'border-success/25 bg-success/10 text-success',
    ask: 'border-warning/25 bg-warning/10 text-warning',
    deny: 'border-destructive/25 bg-destructive/10 text-destructive',
  };

  return (
    <div data-testid="shell-command-rules" className="border-t border-border/30 pt-5">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <CodeBlock className="h-3.5 w-3.5 text-muted-foreground" />
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {t('settings:tool_permissions.shell_rules.title')}
            </h4>
            <span className="text-xs text-muted-foreground">({rules.length})</span>
          </div>
          <p className="mt-1 max-w-3xl text-xs text-muted-foreground leading-relaxed">
            {t('settings:tool_permissions.shell_rules.desc')}
          </p>
        </div>
        <DsButton variant="outline" size="sm" onClick={beginAdd} disabled={loading || saving} className="[@media(pointer:coarse)]:!min-h-11">
          <Plus className="h-3.5 w-3.5 mr-1" />
          {t('settings:tool_permissions.shell_rules.add')}
        </DsButton>
      </div>

      <div className="rounded-lg border border-border/40 bg-muted/10 p-3 mb-3">
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:justify-between">
          <div>
            <div className="text-xs font-medium text-foreground">{t('settings:tool_permissions.shell_rules.default_title')}</div>
            <div className="text-xs text-muted-foreground mt-0.5">{t('settings:tool_permissions.shell_rules.default_desc')}</div>
          </div>
          <div className="flex items-center gap-0.5 rounded-md bg-muted/50 p-0.5 self-start sm:self-auto" role="group" aria-label={t('settings:tool_permissions.shell_rules.default_title')}>
            {(['allow', 'ask', 'deny'] as ShellCommandAction[]).map(effect => (
              <DsButton
                key={effect}
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={() => void handleDefaultEffect(effect)}
                aria-pressed={defaultEffect === effect}
                className={cn('!h-7 !px-2 text-xs [@media(pointer:coarse)]:!h-11', defaultEffect === effect && actionClass[effect])}
              >
                {t(`settings:tool_permissions.shell_rules.action_${effect}`)}
              </DsButton>
            ))}
          </div>
        </div>
        {pendingDefaultAllow && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-2 text-xs text-warning">
            <Warning className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="flex-1">{t('settings:tool_permissions.shell_rules.default_allow_warning')}</span>
            <DsButton variant="ghost" size="sm" onClick={() => void handleDefaultEffect('allow')} className="!h-6 text-xs [@media(pointer:coarse)]:!h-11">
              {t('settings:tool_permissions.shell_rules.confirm_allow')}
            </DsButton>
          </div>
        )}
      </div>

      <div className="mb-3 flex items-start gap-2 rounded-md border border-border/30 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
        <Lock className="mt-px h-3.5 w-3.5 flex-shrink-0" />
        <span>{t('settings:tool_permissions.shell_rules.safety_boundary')}</span>
      </div>

      <div className="mb-3 rounded-lg border border-border/40 bg-muted/10 p-3">
        <div className="mb-2 text-xs font-medium text-foreground">{t('settings:tool_permissions.shell_rules.preview_title')}</div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            {...TECHNICAL_INPUT_PROPS}
            value={previewCommand}
            onChange={event => setPreviewCommand(event.target.value)}
            placeholder={t('settings:tool_permissions.shell_rules.preview_placeholder')}
            aria-label={t('settings:tool_permissions.shell_rules.preview_title')}
            className="min-w-0 flex-1 font-mono [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:text-[16px]"
          />
          {preview && (
            <div className="flex min-h-8 items-center gap-2 text-xs sm:max-w-[45%]">
              <span className={cn('shrink-0 rounded border px-1.5 py-0.5 text-2xs', actionClass[preview.effect])}>
                {t(`settings:tool_permissions.shell_rules.action_${preview.effect}`)}
              </span>
              <span className="truncate text-muted-foreground" title={preview.matchedRule?.pattern}>
                {preview.matchedRule
                  ? t('settings:tool_permissions.shell_rules.preview_matched', { pattern: preview.matchedRule.pattern })
                  : t('settings:tool_permissions.shell_rules.preview_default')}
              </span>
            </div>
          )}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">{t('settings:tool_permissions.shell_rules.preview_hint')}</p>
      </div>

      {showEditor && (
        <div className="mb-3 rounded-lg border border-primary/20 bg-primary/[0.025] p-3">
          <div className="mb-2 text-xs font-medium text-foreground">
            {t(editingId ? 'settings:tool_permissions.shell_rules.edit_title' : 'settings:tool_permissions.shell_rules.add_title')}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[8rem_10rem_minmax(12rem,1fr)] gap-2">
            <Select value={draft.action} onValueChange={value => { setDraft(prev => ({ ...prev, action: value as ShellCommandAction })); setPendingRisk(null); }}>
              <SelectTrigger className="[@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:text-[16px]" aria-label={t('settings:tool_permissions.shell_rules.effect_label')}><SelectValue /></SelectTrigger>
              <SelectContent>{(['allow', 'ask', 'deny'] as const).map(value => <SelectItem key={value} value={value}>{t(`settings:tool_permissions.shell_rules.action_${value}`)}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={draft.matchType} onValueChange={value => { setDraft(prev => ({ ...prev, matchType: value as ShellCommandMatchType })); setDraftError(null); setPendingRisk(null); }}>
              <SelectTrigger className="[@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:text-[16px]" aria-label={t('settings:tool_permissions.shell_rules.match_label')}><SelectValue /></SelectTrigger>
              <SelectContent>{(['exact', 'prefix', 'executable'] as const).map(value => <SelectItem key={value} value={value}>{t(`settings:tool_permissions.shell_rules.match_${value}`)}</SelectItem>)}</SelectContent>
            </Select>
            <Input
              value={draft.pattern}
              onChange={event => { setDraft(prev => ({ ...prev, pattern: event.target.value })); setDraftError(null); setPendingRisk(null); }}
              placeholder={t(`settings:tool_permissions.shell_rules.placeholder_${draft.matchType}`)}
              aria-label={t('settings:tool_permissions.shell_rules.pattern_label')}
              className="font-mono [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:text-[16px]"
              autoFocus
            />
          </div>
          <Input value={draft.note} onChange={event => setDraft(prev => ({ ...prev, note: event.target.value }))} placeholder={t('settings:tool_permissions.shell_rules.note_placeholder')} aria-label={t('settings:tool_permissions.shell_rules.note_label')} className="mt-2 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:text-[16px]" />
          <p className="mt-1.5 text-xs text-muted-foreground">{t(`settings:tool_permissions.shell_rules.help_${draft.matchType}`)}</p>
          {draftError && <p className="mt-2 text-xs text-destructive">{t(`settings:tool_permissions.shell_rules.error_${draftError}`)}</p>}
          {pendingRisk && (
            <div className="mt-2 flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-2 text-xs text-warning">
              <Warning className="mt-px h-3.5 w-3.5 flex-shrink-0" />
              <span>{t('settings:tool_permissions.shell_rules.broad_allow_warning')}</span>
            </div>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <DsButton variant="outline" size="sm" onClick={() => { setShowEditor(false); setPendingRisk(null); }} className="[@media(pointer:coarse)]:!min-h-11">{t('common:cancel')}</DsButton>
            <DsButton variant="primary" size="sm" onClick={() => void saveDraft()} disabled={saving} className="[@media(pointer:coarse)]:!min-h-11">
              {t(pendingRisk ? 'settings:tool_permissions.shell_rules.confirm_allow' : 'common:save')}
            </DsButton>
          </div>
        </div>
      )}

      {loading ? <div className="h-24 rounded-lg bg-muted/20 animate-pulse" /> : rules.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/50 py-6 px-4">
          <CodeBlock className="mb-2 h-5 w-5 text-muted-foreground/40" />
          <p className="text-xs text-muted-foreground">{t('settings:tool_permissions.shell_rules.empty')}</p>
          <p className="mt-1 text-xs text-muted-foreground/80">{t('settings:tool_permissions.shell_rules.empty_hint')}</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-[minmax(10rem,1fr)_9rem_10rem] gap-2 mb-2">
            <div className="relative"><MagnifyingGlass className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" /><Input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('settings:tool_permissions.shell_rules.search')} aria-label={t('settings:tool_permissions.shell_rules.search')} className="pl-8 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:text-[16px]" /></div>
            <Select value={actionFilter} onValueChange={value => setActionFilter(value as ShellCommandAction | 'all')}><SelectTrigger className="[@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:text-[16px]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t('settings:tool_permissions.shell_rules.all_effects')}</SelectItem>{(['allow', 'ask', 'deny'] as const).map(value => <SelectItem key={value} value={value}>{t(`settings:tool_permissions.shell_rules.action_${value}`)}</SelectItem>)}</SelectContent></Select>
            <Select value={typeFilter} onValueChange={value => setTypeFilter(value as ShellCommandMatchType | 'all')}><SelectTrigger className="[@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:text-[16px]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t('settings:tool_permissions.shell_rules.all_matches')}</SelectItem>{(['exact', 'prefix', 'executable'] as const).map(value => <SelectItem key={value} value={value}>{t(`settings:tool_permissions.shell_rules.match_${value}`)}</SelectItem>)}</SelectContent></Select>
          </div>
          <div className="mb-2 flex min-h-8 flex-wrap items-center gap-2 [@media(pointer:coarse)]:min-h-11">
            <Checkbox
                      checked={allVisibleSelected ? true : selectedRuleIds.size > 0 ? 'indeterminate' : false}
              onCheckedChange={checked => selectVisibleRules(checked === true)}
              aria-label={t('settings:tool_permissions.shell_rules.select_visible')}
              className="relative [@media(pointer:coarse)]:before:content-[''] [@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:-inset-3.5"
            />
            <span className="text-xs text-muted-foreground">
              {selectedRuleIds.size > 0
                ? t('settings:tool_permissions.shell_rules.selected_count', { count: selectedRuleIds.size })
                : t('settings:tool_permissions.shell_rules.select_visible')}
            </span>
            {selectedRuleIds.size > 0 && (
              <div className="ml-auto flex flex-wrap items-center gap-1">
                <DsButton variant="outline" size="sm" disabled={saving} onClick={() => void updateSelectedRules('enable')} className="[@media(pointer:coarse)]:!min-h-11">{t('settings:tool_permissions.shell_rules.bulk_enable')}</DsButton>
                <DsButton variant="outline" size="sm" disabled={saving} onClick={() => void updateSelectedRules('disable')} className="[@media(pointer:coarse)]:!min-h-11">{t('settings:tool_permissions.shell_rules.bulk_disable')}</DsButton>
                <DsButton variant="outline" size="sm" disabled={saving} onClick={() => void updateSelectedRules('delete')} className="!text-destructive [@media(pointer:coarse)]:!min-h-11">{t('settings:tool_permissions.shell_rules.bulk_delete')}</DsButton>
              </div>
            )}
          </div>
          {filteredRules.length === 0 ? <div className="rounded-md border border-dashed border-border/50 py-5 px-4 text-xs text-muted-foreground">{t('settings:tool_permissions.shell_rules.no_matches')}</div> : (
            <div className="overflow-hidden rounded-lg border border-border/40 divide-y divide-border/30">
              {filteredRules.map(rule => {
                const risk = assessShellCommandRuleRisk(rule);
                return <div key={rule.id} className={cn('flex flex-col sm:flex-row sm:items-center gap-2 px-3 py-2.5', !rule.enabled && 'opacity-60')}>
                  <Checkbox
                    checked={selectedRuleIds.has(rule.id)}
                    onCheckedChange={checked => setSelectedRuleIds(previous => {
                      const next = new Set(previous);
                      if (checked === true) next.add(rule.id); else next.delete(rule.id);
                      return next;
                    })}
                    aria-label={t('settings:tool_permissions.shell_rules.select_rule', { pattern: rule.pattern })}
                    className="relative [@media(pointer:coarse)]:before:content-[''] [@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:-inset-3.5"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <code className="break-all text-xs font-medium text-foreground">{rule.pattern}</code>
                      <span className={cn('rounded border px-1.5 py-0.5 text-2xs', actionClass[rule.action])}>{t(`settings:tool_permissions.shell_rules.action_${rule.action}`)}</span>
                      <span className="rounded border border-border/40 px-1.5 py-0.5 text-2xs text-muted-foreground">{t(`settings:tool_permissions.shell_rules.match_${rule.matchType}`)}</span>
                      {risk && <span className="inline-flex items-center gap-1 rounded border border-warning/30 bg-warning/5 px-1.5 py-0.5 text-2xs text-warning"><Warning className="h-3 w-3" />{t('settings:tool_permissions.shell_rules.broad_badge')}</span>}
                    </div>
                    {rule.note && <p className="mt-1 truncate text-xs text-muted-foreground" title={rule.note}>{rule.note}</p>}
                  </div>
                  <div className="flex items-center justify-end gap-1">
                    <Switch checked={rule.enabled} disabled={saving} onCheckedChange={enabled => void setRuleEnabled(rule, enabled)} aria-label={t('settings:tool_permissions.shell_rules.toggle_rule', { pattern: rule.pattern })} />
                    <DsButton variant="ghost" size="icon" iconOnly onClick={() => beginEdit(rule)} className="!h-7 !w-7 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11" title={t('common:actions.edit')} aria-label={t('common:actions.edit')}><PencilSimple className="h-3.5 w-3.5" /></DsButton>
                    <DsButton variant="ghost" size="icon" iconOnly onClick={() => void deleteRule(rule)} className="!h-7 !w-7 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11 text-muted-foreground hover:text-destructive" title={t('common:delete')} aria-label={t('common:delete')}><Trash className="h-3.5 w-3.5" /></DsButton>
                  </div>
                </div>;
              })}
            </div>
          )}
        </>
      )}
      {confirmDialog}
    </div>
  );
}

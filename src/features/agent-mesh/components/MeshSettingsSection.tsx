import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowsClockwise,
  FolderOpen,
  PencilSimple,
  Plus,
  SlidersHorizontal,
  Trash,
} from '@phosphor-icons/react';
import { SettingSection, settingsQuietInteractiveRowClassName } from '@/components/settings/SettingsCommon';
import { SettingRow, SettingsGroup, SwitchRow } from '@/components/settings/settingsTabPrimitives';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import type { SettingsSectionRenderProps } from '@/ui-kernel/contracts/settings';

async function resolveErrorMessage(error: unknown): Promise<string> {
  try {
    const { getErrorMessage } = await import('@/utils/errorUtils');
    return getErrorMessage(error);
  } catch {
    if (error instanceof Error && error.message.trim()) return error.message;
    if (typeof error === 'string' && error.trim()) return error;
    return 'An unknown error occurred';
  }
}
import { cn } from '@/lib/utils';
import type { MeshAgentInfo, MeshCustomCliTemplate } from '../workbench-types';
import { useAgentMeshWorkbenchStore } from '../workbenchBridge';

export type MeshSettingsSectionProps = Partial<SettingsSectionRenderProps>;

async function pickExecutableFileNative(title: string): Promise<string | null> {
  try {
    const { open: dialogOpen } = await import('@tauri-apps/plugin-dialog');
    const selected = await dialogOpen({
      directory: false,
      multiple: false,
      title,
    });
    if (typeof selected === 'string' && selected.trim()) {
      return selected.trim();
    }
  } catch {
    // Non-desktop / test environment fallback: keep manual text input usable.
  }
  return null;
}

export const MeshSettingsSection: React.FC<MeshSettingsSectionProps> = () => {
  const { t } = useTranslation(['agentMesh', 'settings', 'common']);
  const tr = useCallback(
    (key: string, defaultValue: string, vars?: Record<string, string | number>) => {
      const res = t(key, { defaultValue, ...vars });
      if (res && res !== key && !res.startsWith('agentMesh:')) return res;
      if (!vars) return defaultValue;
      return defaultValue.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) =>
        vars[k] !== undefined ? String(vars[k]) : '',
      );
    },
    [t],
  );

  const agents = useAgentMeshWorkbenchStore((s) => s.agents);
  const customTemplates = useAgentMeshWorkbenchStore((s) => s.customTemplates);
  const probing = useAgentMeshWorkbenchStore((s) => s.probing);
  const safetyPreferences = useAgentMeshWorkbenchStore((s) => s.safetyPreferences);

  const probeDetectedAgents = useAgentMeshWorkbenchStore((s) => s.probeDetectedAgents);
  const updateSafetyPreferences = useAgentMeshWorkbenchStore((s) => s.updateSafetyPreferences);
  const saveCustomTemplate = useAgentMeshWorkbenchStore((s) => s.saveCustomTemplate);
  const removeCustomTemplate = useAgentMeshWorkbenchStore((s) => s.removeCustomTemplate);
  const saveCliOverride = useAgentMeshWorkbenchStore((s) => s.saveCliOverride);
  const resetCliOverride = useAgentMeshWorkbenchStore((s) => s.resetCliOverride);

  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [overridePathDraft, setOverridePathDraft] = useState('');
  const [overrideArgsDraft, setOverrideArgsDraft] = useState('');
  const [savingOverrideId, setSavingOverrideId] = useState<string | null>(null);

  const [addingCustom, setAddingCustom] = useState(false);
  const [editingCustomId, setEditingCustomId] = useState<string | null>(null);
  const [customId, setCustomId] = useState('');
  const [customName, setCustomName] = useState('');
  const [customCommand, setCustomCommand] = useState('');
  const [customArgs, setCustomArgs] = useState('');
  const [savingCustom, setSavingCustom] = useState(false);
  const [deletingCustomId, setDeletingCustomId] = useState<string | null>(null);
  const [maxHopsDraft, setMaxHopsDraft] = useState<string>(
    String(safetyPreferences.maxAutonomousHops),
  );

  useEffect(() => {
    setMaxHopsDraft(String(safetyPreferences.maxAutonomousHops));
  }, [safetyPreferences.maxAutonomousHops]);

  const commitMaxHopsDraft = useCallback(() => {
    const trimmed = maxHopsDraft.trim();
    const parsed = trimmed === '' ? Number.NaN : Number(trimmed);
    const clamped = Number.isFinite(parsed)
      ? Math.max(2, Math.min(64, Math.round(parsed)))
      : safetyPreferences.maxAutonomousHops;
    setMaxHopsDraft(String(clamped));
    if (clamped !== safetyPreferences.maxAutonomousHops) {
      updateSafetyPreferences({ maxAutonomousHops: clamped });
    }
  }, [maxHopsDraft, safetyPreferences.maxAutonomousHops, updateSafetyPreferences]);

  useEffect(() => {
    void probeDetectedAgents(false);
  }, [probeDetectedAgents]);

  const builtInExternalAgents = useMemo(
    () => agents.filter((agent) => agent.driver !== 'builtin' && agent.driver !== 'custom'),
    [agents],
  );

  const openAgentOverrideEditor = useCallback((agent: MeshAgentInfo) => {
    setEditingAgentId((prev) => {
      if (prev === agent.id) return null;
      setOverridePathDraft(agent.customExecutablePath ?? agent.binaryPath ?? '');
      setOverrideArgsDraft((agent.extraArgs ?? []).join(' '));
      return agent.id;
    });
  }, []);

  const handleSaveOverride = async (e: React.FormEvent, agentId: string) => {
    e.preventDefault();
    if (savingOverrideId) return;
    setSavingOverrideId(agentId);
    try {
      await saveCliOverride({
        agentId,
        executablePath: overridePathDraft.trim() || null,
        extraArgs: overrideArgsDraft
          .split(/\s+/)
          .map((s) => s.trim())
          .filter(Boolean),
      });
      setEditingAgentId(null);
    } catch (err) {
      showGlobalNotification('error', await resolveErrorMessage(err));
    } finally {
      setSavingOverrideId(null);
    }
  };

  const handleResetOverride = async (agentId: string) => {
    if (savingOverrideId) return;
    setSavingOverrideId(agentId);
    try {
      await resetCliOverride(agentId);
      setOverridePathDraft('');
      setOverrideArgsDraft('');
      setEditingAgentId(null);
    } catch (err) {
      showGlobalNotification('error', await resolveErrorMessage(err));
    } finally {
      setSavingOverrideId(null);
    }
  };

  const handleBrowseOverridePath = async (agentName: string) => {
    const picked = await pickExecutableFileNative(
      tr('settings.browseBinaryDialogTitle', '选择 {{name}} 可执行文件', { name: agentName }),
    );
    if (picked) {
      setOverridePathDraft(picked);
    }
  };

  const handleBrowseCustomCommand = async () => {
    const picked = await pickExecutableFileNative(
      tr('settings.browseCustomDialogTitle', '选择自定义 CLI 可执行文件'),
    );
    if (picked) {
      setCustomCommand(picked);
    }
  };

  const openEditCustomTemplate = (tpl: MeshCustomCliTemplate) => {
    setEditingCustomId(tpl.id);
    setCustomId(tpl.id);
    setCustomName(tpl.name);
    setCustomCommand(tpl.command);
    setCustomArgs((tpl.args ?? []).join(' '));
    setAddingCustom(true);
  };

  const closeCustomForm = () => {
    setAddingCustom(false);
    setEditingCustomId(null);
    setCustomId('');
    setCustomName('');
    setCustomCommand('');
    setCustomArgs('');
  };

  const handleSaveCustom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (savingCustom || !customId.trim() || !customCommand.trim()) return;
    setSavingCustom(true);
    try {
      await saveCustomTemplate({
        id: customId.trim(),
        name: customName.trim() || customId.trim(),
        command: customCommand.trim(),
        args: customArgs
          .split(/\s+/)
          .map((s) => s.trim())
          .filter(Boolean),
      });
      closeCustomForm();
    } catch (err) {
      showGlobalNotification('error', await resolveErrorMessage(err));
    } finally {
      setSavingCustom(false);
    }
  };

  const handleRemoveCustom = async (id: string) => {
    if (deletingCustomId) return;
    setDeletingCustomId(id);
    try {
      await removeCustomTemplate(id);
    } catch (err) {
      showGlobalNotification('error', await resolveErrorMessage(err));
    } finally {
      setDeletingCustomId(null);
    }
  };

  return (
    <div data-testid="mesh-settings-section" className="space-y-8 pb-10 text-left ui-fade-in-slow">
      <SettingSection
        title={tr('settings.title', '编程 CLI')}
        description={tr(
          'settings.description',
          '自动检测本机已安装的命令行编程工具，在对话输入框中通过 @工具名 即可直接调用或协同处理代码任务。',
        )}
        hideHeader
      >
        {/* 1. 本机已安装的外部编程 CLI 列表 */}
        <SettingsGroup
          title={tr('settings.detectedClisTitle', '本机编程 CLI')}
          description={tr(
            'settings.detectedClisDesc',
            '自动探测或手动指定各编程 CLI 的可执行路径与附加参数；在输入框中输入 @claude、@codex 等即可直接调用。',
          )}
          actions={
            <DsButton
              size="sm"
              variant="ghost"
              disabled={probing}
              data-testid="mesh-settings-reprobe-btn"
              className="gap-1.5 text-muted-foreground hover:text-foreground"
              onClick={() => void probeDetectedAgents(true)}
            >
              <ArrowsClockwise size={14} className={cn(probing && 'animate-spin')} aria-hidden="true" />
              <span>{tr('settings.rescan', '重新检测')}</span>
            </DsButton>
          }
        >
          {builtInExternalAgents.map((agent) => {
            const hasOverride = Boolean(
              agent.customExecutablePath || (agent.extraArgs && agent.extraArgs.length > 0),
            );
            const isEditing = editingAgentId === agent.id;
            const isSaving = savingOverrideId === agent.id;

            const detailLine = agent.available
              ? [
                  agent.version,
                  agent.binaryPath,
                  agent.extraArgs && agent.extraArgs.length > 0
                    ? `(${agent.extraArgs.join(' ')})`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : agent.probeError
                ? [agent.customExecutablePath, agent.probeError].filter(Boolean).join(' · ')
                : tr('settings.notDetectedHint', '未检测到本机可执行文件');

            return (
              <div
                key={agent.id}
                data-testid={`mesh-settings-agent-${agent.id}`}
                className="rounded-xl"
              >
                <div
                  className={cn(
                    'group flex min-w-0 items-center justify-between gap-3 px-2 py-2.5',
                    settingsQuietInteractiveRowClassName,
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        aria-hidden="true"
                        className={cn(
                          'h-2 w-2 shrink-0 rounded-full',
                          agent.available ? 'bg-success' : 'bg-muted-foreground/35',
                        )}
                      />
                      <span className="truncate text-sm text-foreground/90 leading-tight">
                        {agent.name}
                      </span>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground/70">
                        {agent.handle}
                      </span>
                      {agent.customExecutablePath && (
                        <span
                          data-testid={`mesh-settings-custom-path-badge-${agent.id}`}
                          className="shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 text-2xs font-medium text-primary"
                        >
                          {tr('settings.customPathBadge', '自定义路径')}
                        </span>
                      )}
                    </div>
                    {detailLine && (
                      <p
                        className={cn(
                          'mt-0.5 truncate pl-4 font-mono text-xs leading-relaxed',
                          !agent.available && agent.probeError
                            ? 'text-warning'
                            : 'text-muted-foreground/70',
                        )}
                        title={detailLine}
                      >
                        {detailLine}
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <span
                      className={cn(
                        'text-xs',
                        agent.available ? 'text-foreground/75' : 'text-muted-foreground/50',
                      )}
                    >
                      {agent.available
                        ? tr('settings.agentReady', '已就绪')
                        : tr('settings.agentMissing', '未安装')}
                    </span>
                    <DsButton
                      size="sm"
                      variant="ghost"
                      data-testid={`mesh-settings-configure-${agent.id}`}
                      aria-expanded={isEditing}
                      className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => openAgentOverrideEditor(agent)}
                    >
                      <SlidersHorizontal size={13} aria-hidden="true" />
                      <span>{tr('settings.configurePath', '配置路径')}</span>
                    </DsButton>
                  </div>
                </div>

                {isEditing && (
                  <form
                    onSubmit={(e) => void handleSaveOverride(e, agent.id)}
                    data-testid={`mesh-settings-override-form-${agent.id}`}
                    className="mx-2 mb-2 mt-1 space-y-2.5 rounded-xl border border-border/60 bg-background/60 p-3"
                  >
                    <div className="space-y-1">
                      <label
                        htmlFor={`cli-override-path-${agent.id}`}
                        className="block text-xs font-medium text-foreground/80"
                      >
                        {tr('settings.overridePathLabel', '可执行文件路径（留空则自动探测）')}
                      </label>
                      <div className="flex items-center gap-2">
                        <Input
                          id={`cli-override-path-${agent.id}`}
                          value={overridePathDraft}
                          onChange={(e) => setOverridePathDraft(e.target.value)}
                          placeholder={tr(
                            'settings.overridePathPlaceholder',
                            '例如 /opt/homebrew/bin/{{cmd}} 或应用内置路径',
                            { cmd: agent.id },
                          )}
                          data-testid={`mesh-settings-override-path-${agent.id}`}
                          className="font-mono text-xs"
                        />
                        <DsButton
                          type="button"
                          size="sm"
                          variant="outline"
                          data-testid={`mesh-settings-override-browse-${agent.id}`}
                          className="shrink-0 gap-1"
                          onClick={() => void handleBrowseOverridePath(agent.name)}
                        >
                          <FolderOpen size={13} aria-hidden="true" />
                          <span>{tr('settings.browseBinary', '浏览…')}</span>
                        </DsButton>
                      </div>
                    </div>

                    <div className="space-y-1">
                      <label
                        htmlFor={`cli-override-args-${agent.id}`}
                        className="block text-xs font-medium text-foreground/80"
                      >
                        {tr('settings.overrideArgsLabel', '附加启动参数（空格分隔，可选）')}
                      </label>
                      <Input
                        id={`cli-override-args-${agent.id}`}
                        value={overrideArgsDraft}
                        onChange={(e) => setOverrideArgsDraft(e.target.value)}
                        placeholder={tr(
                          'settings.overrideArgsPlaceholder',
                          '例如 --sandbox workspace-write',
                        )}
                        data-testid={`mesh-settings-override-args-${agent.id}`}
                        className="font-mono text-xs"
                      />
                    </div>

                    <div className="flex items-center justify-between gap-2 pt-1">
                      <div>
                        {hasOverride && (
                          <DsButton
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={isSaving}
                            data-testid={`mesh-settings-override-reset-${agent.id}`}
                            className="text-xs text-muted-foreground hover:text-foreground"
                            onClick={() => void handleResetOverride(agent.id)}
                          >
                            {tr('settings.resetAutoDetect', '恢复自动探测')}
                          </DsButton>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <DsButton
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={isSaving}
                          onClick={() => setEditingAgentId(null)}
                        >
                          {tr('settings.cancel', '取消')}
                        </DsButton>
                        <DsButton
                          type="submit"
                          size="sm"
                          variant="primary"
                          disabled={isSaving}
                          data-testid={`mesh-settings-override-save-${agent.id}`}
                        >
                          {isSaving
                            ? tr('settings.savingAndTesting', '检测中…')
                            : tr('settings.saveAndTest', '保存并检测')}
                        </DsButton>
                      </div>
                    </div>
                  </form>
                )}
              </div>
            );
          })}
        </SettingsGroup>

        {/* 2. 自定义命令行工具 */}
        <div className="mt-8">
          <SettingsGroup
            title={tr('settings.customTemplates', '自定义命令行工具')}
            description={tr(
              'settings.customTemplatesDesc',
              '接入其他支持命令行调用的本地编程工具。',
            )}
            actions={
              !addingCustom ? (
                <DsButton
                  size="sm"
                  variant="outline"
                  data-testid="mesh-settings-add-custom-btn"
                  className="gap-1.5"
                  onClick={() => {
                    setEditingCustomId(null);
                    setAddingCustom(true);
                  }}
                >
                  <Plus size={14} aria-hidden="true" />
                  <span>{tr('settings.addTemplate', '添加工具')}</span>
                </DsButton>
              ) : undefined
            }
          >
            {addingCustom && (
              <form
                onSubmit={(e) => void handleSaveCustom(e)}
                data-testid="mesh-settings-custom-form"
                className="mb-2 space-y-3 rounded-xl border border-border/60 bg-background/60 p-3"
              >
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  <Input
                    value={customId}
                    onChange={(e) => setCustomId(e.target.value)}
                    disabled={editingCustomId !== null}
                    placeholder={tr('settings.customIdPlaceholder', '调用代号（如 aider）')}
                    data-testid="mesh-settings-custom-id"
                  />
                  <Input
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    placeholder={tr('settings.customNamePlaceholder', '显示名称（如 Aider CLI）')}
                    data-testid="mesh-settings-custom-name"
                  />
                  <div className="flex items-center gap-1.5">
                    <Input
                      value={customCommand}
                      onChange={(e) => setCustomCommand(e.target.value)}
                      placeholder={tr('settings.customCommandPlaceholder', '可执行命令或路径')}
                      data-testid="mesh-settings-custom-command"
                      className="font-mono text-xs"
                    />
                    <DsButton
                      type="button"
                      size="sm"
                      variant="outline"
                      data-testid="mesh-settings-custom-browse"
                      className="shrink-0 gap-1"
                      onClick={() => void handleBrowseCustomCommand()}
                    >
                      <FolderOpen size={13} aria-hidden="true" />
                      <span>{tr('settings.browseBinary', '浏览…')}</span>
                    </DsButton>
                  </div>
                  <Input
                    value={customArgs}
                    onChange={(e) => setCustomArgs(e.target.value)}
                    placeholder={tr('settings.customArgsPlaceholder', '默认参数（空格分隔，可选）')}
                    data-testid="mesh-settings-custom-args"
                    className="font-mono text-xs"
                  />
                </div>
                <div className="flex items-center justify-end gap-2">
                  <DsButton
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={savingCustom}
                    onClick={closeCustomForm}
                  >
                    {tr('settings.cancel', '取消')}
                  </DsButton>
                  <DsButton
                    type="submit"
                    size="sm"
                    variant="primary"
                    disabled={savingCustom || !customId.trim() || !customCommand.trim()}
                    data-testid="mesh-settings-custom-save"
                  >
                    {tr('settings.save', '保存')}
                  </DsButton>
                </div>
              </form>
            )}

            {customTemplates.length === 0 && !addingCustom ? (
              <p className="px-2 py-2 text-xs text-muted-foreground/70">
                {tr('settings.customEmpty', '暂未添加自定义命令行工具')}
              </p>
            ) : (
              customTemplates.map((tpl) => (
                <div
                  key={tpl.id}
                  data-testid={`mesh-settings-custom-item-${tpl.id}`}
                  className={cn(
                    'group flex min-w-0 items-center justify-between gap-3 px-2 py-2.5',
                    settingsQuietInteractiveRowClassName,
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm text-foreground/90">{tpl.name}</span>
                      <span className="font-mono text-xs text-muted-foreground/70">@{tpl.id}</span>
                    </div>
                    <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground/70">
                      {[tpl.command, ...(tpl.args ?? [])].join(' ')}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <DsButton
                      size="icon"
                      variant="ghost"
                      iconOnly
                      aria-label={tr('settings.editCustomAria', '编辑 {{name}}', { name: tpl.name })}
                      data-testid={`mesh-settings-custom-edit-${tpl.id}`}
                      className="!h-8 !w-8 text-muted-foreground hover:text-foreground"
                      onClick={() => openEditCustomTemplate(tpl)}
                    >
                      <PencilSimple size={14} aria-hidden="true" />
                    </DsButton>
                    <DsButton
                      size="icon"
                      variant="ghost"
                      iconOnly
                      disabled={deletingCustomId === tpl.id}
                      aria-label={tr('settings.deleteCustomAria', '删除 {{name}}', { name: tpl.name })}
                      data-testid={`mesh-settings-custom-delete-${tpl.id}`}
                      className="!h-8 !w-8 text-muted-foreground hover:text-destructive"
                      onClick={() => void handleRemoveCustom(tpl.id)}
                    >
                      <Trash size={14} aria-hidden="true" />
                    </DsButton>
                  </div>
                </div>
              ))
            )}
          </SettingsGroup>
        </div>

        {/* 3. 协作与安全策略 */}
        <div className="mt-8">
          <SettingsGroup
            title={tr('settings.safetyTitle', '协作与安全')}
            description={tr(
              'settings.safetyDesc',
              '控制外部 CLI 在本地工作目录中的修改方式与多工具并发保护。',
            )}
          >
            <SwitchRow
              title={tr('settings.inPlaceModeTitle', '默认在原目录直接协作')}
              description={tr(
                'settings.inPlaceModeDesc',
                '不强制新建独立工作树，每轮自动生成无侵入隐藏快照以便随时回退。',
              )}
              checked={safetyPreferences.defaultInPlaceMode}
              onCheckedChange={(checked) =>
                updateSafetyPreferences({ defaultInPlaceMode: checked })
              }
            />

            <SwitchRow
              title={tr('settings.fileLeasesTitle', '并发文件防冲突锁')}
              description={tr(
                'settings.fileLeasesDesc',
                '多个工具在同一目录下并发执行时，自动按路径协调写入顺序，防止互相覆盖。',
              )}
              checked={safetyPreferences.autoAcquireFileLeases}
              onCheckedChange={(checked) =>
                updateSafetyPreferences({ autoAcquireFileLeases: checked })
              }
            />

            <SwitchRow
              title={tr('settings.studyContextTitle', '共享当前学习上下文')}
              description={tr(
                'settings.studyContextDesc',
                '允许外部编程工具按需读取当前会话关联的笔记与资料片段。',
              )}
              checked={safetyPreferences.allowStudyContextMcp}
              onCheckedChange={(checked) =>
                updateSafetyPreferences({ allowStudyContextMcp: checked })
              }
            />

            <SettingRow
              title={tr('settings.maxHopsLabel', '连续自动接力上限')}
              description={tr(
                'settings.maxHopsDesc',
                '无人工介入的最大连续自动唤醒轮数，达到上限后自动暂停并等待确认。',
              )}
            >
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={2}
                  max={64}
                  data-testid="mesh-settings-max-hops-input"
                  aria-label={tr('settings.maxHopsLabel', '连续自动接力上限')}
                  value={maxHopsDraft}
                  onChange={(e) => setMaxHopsDraft(e.target.value)}
                  onBlur={commitMaxHopsDraft}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitMaxHopsDraft();
                    }
                  }}
                  className="!w-24"
                />
                <span className="text-xs text-muted-foreground/70">
                  {tr('settings.roundsUnit', '轮')}
                </span>
              </div>
            </SettingRow>
          </SettingsGroup>
        </div>
      </SettingSection>
    </div>
  );
};

export default MeshSettingsSection;

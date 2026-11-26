import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowsClockwise, Plus, Trash } from '@phosphor-icons/react';
import { SettingSection, settingsQuietInteractiveRowClassName } from '@/components/settings/SettingsCommon';
import { SettingRow, SettingsGroup, SwitchRow } from '@/components/settings/settingsTabPrimitives';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import type { SettingsSectionRenderProps } from '@/ui-kernel/contracts/settings';
import { cn } from '@/lib/utils';
import { useAgentMeshWorkbenchStore } from '../workbenchBridge';

export type MeshSettingsSectionProps = Partial<SettingsSectionRenderProps>;

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

  const [addingCustom, setAddingCustom] = useState(false);
  const [customId, setCustomId] = useState('');
  const [customName, setCustomName] = useState('');
  const [customCommand, setCustomCommand] = useState('');
  const [customArgs, setCustomArgs] = useState('');

  useEffect(() => {
    void probeDetectedAgents(false);
  }, [probeDetectedAgents]);

  const externalAgents = useMemo(
    () => agents.filter((agent) => agent.driver !== 'builtin'),
    [agents],
  );

  const handleSaveCustom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customId.trim() || !customCommand.trim()) return;
    await saveCustomTemplate({
      id: customId.trim(),
      name: customName.trim() || customId.trim(),
      command: customCommand.trim(),
      args: customArgs
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean),
    });
    setCustomId('');
    setCustomName('');
    setCustomCommand('');
    setCustomArgs('');
    setAddingCustom(false);
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
            '在对话输入框中输入 @claude、@codex 等即可将任务交给本机命令行编程工具处理。',
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
          {externalAgents.map((agent) => {
            const detailLine = agent.available
              ? [agent.version, agent.binaryPath].filter(Boolean).join(' · ')
              : tr('settings.notDetectedHint', '未检测到本机可执行文件');

            return (
              <div
                key={agent.id}
                data-testid={`mesh-settings-agent-${agent.id}`}
                className={cn(
                  'group flex min-w-0 items-center justify-between gap-4 px-2 py-2.5',
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
                  </div>
                  {detailLine && (
                    <p className="mt-0.5 truncate pl-4 font-mono text-xs leading-relaxed text-muted-foreground/70">
                      {detailLine}
                    </p>
                  )}
                </div>

                <span
                  className={cn(
                    'shrink-0 text-xs',
                    agent.available ? 'text-foreground/75' : 'text-muted-foreground/50',
                  )}
                >
                  {agent.available
                    ? tr('settings.agentReady', '已就绪')
                    : tr('settings.agentMissing', '未安装')}
                </span>
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
                  onClick={() => setAddingCustom(true)}
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
                className="space-y-3 rounded-xl bg-background/60 p-3 mb-2"
              >
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  <Input
                    value={customId}
                    onChange={(e) => setCustomId(e.target.value)}
                    placeholder={tr('settings.customIdPlaceholder', '调用代号（如 aider）')}
                    data-testid="mesh-settings-custom-id"
                  />
                  <Input
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    placeholder={tr('settings.customNamePlaceholder', '显示名称（如 Aider CLI）')}
                    data-testid="mesh-settings-custom-name"
                  />
                  <Input
                    value={customCommand}
                    onChange={(e) => setCustomCommand(e.target.value)}
                    placeholder={tr('settings.customCommandPlaceholder', '可执行命令或路径')}
                    data-testid="mesh-settings-custom-command"
                  />
                  <Input
                    value={customArgs}
                    onChange={(e) => setCustomArgs(e.target.value)}
                    placeholder={tr('settings.customArgsPlaceholder', '默认参数（空格分隔，可选）')}
                    data-testid="mesh-settings-custom-args"
                  />
                </div>
                <div className="flex items-center justify-end gap-2">
                  <DsButton
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setAddingCustom(false)}
                  >
                    {tr('settings.cancel', '取消')}
                  </DsButton>
                  <DsButton
                    type="submit"
                    size="sm"
                    variant="primary"
                    disabled={!customId.trim() || !customCommand.trim()}
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
                  <DsButton
                    size="icon"
                    variant="ghost"
                    iconOnly
                    aria-label={tr('settings.deleteCustomAria', '删除 {{name}}', { name: tpl.name })}
                    data-testid={`mesh-settings-custom-delete-${tpl.id}`}
                    className="!h-8 !w-8 text-muted-foreground hover:text-destructive"
                    onClick={() => void removeCustomTemplate(tpl.id)}
                  >
                    <Trash size={14} aria-hidden="true" />
                  </DsButton>
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
                  value={safetyPreferences.maxAutonomousHops}
                  onChange={(e) =>
                    updateSafetyPreferences({
                      maxAutonomousHops: Math.max(2, Math.min(64, Number(e.target.value) || 12)),
                    })
                  }
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

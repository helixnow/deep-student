/**
 * CreateAgentCard — Worker 创建内联展开卡片（原 CreateAgentDialog 模态框内联化）。
 *
 * 设计对齐 PlanGateCard / AgentTaskPanel 内联标杆：
 * - 非模态：不遮罩、不劫持焦点，Escape 仅在卡片内生效
 * - 展开入场使用 ui-rise-in（150ms / --ease-standard，见 ui-motion.css）
 * - 颜色/圆角走语义 token（bg-card / border-border / --chat-radius-md）
 */

import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DsButton } from '@/components/ui/DsButton';
import { Textarea } from '@/components/ui/shad/Textarea';
import { Label } from '@/components/ui/shad/Label';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { cn } from '@/lib/utils';
import { Check, CircleNotch, Plus, X } from '@phosphor-icons/react';
import { createAgent, listAgents, agentMetadataFromInfo } from '../api';
import { useWorkspaceStore } from '../workspaceStore';
import type { WorkspaceAgent } from '../types';
import { useSkillsByLocation } from '../../skills/hooks/useSkillList';
import { getLocalizedSkillDescription, getLocalizedSkillName } from '../../skills/utils';

interface CreateAgentCardProps {
  /** 收起卡片（取消或创建成功后调用） */
  onClose: () => void;
  workspaceId: string;
  currentSessionId?: string;
  className?: string;
}

export const CreateAgentCard: React.FC<CreateAgentCardProps> = ({
  onClose,
  workspaceId,
  currentSessionId,
  className,
}) => {
  const { t } = useTranslation('chatV2');
  const builtinSkills = useSkillsByLocation('builtin');
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [initialTask, setInitialTask] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // 内联非模态：入场时聚焦卡片本身，方便 Escape 收起；不做焦点陷阱
  useEffect(() => {
    const raf = window.requestAnimationFrame(() => {
      cardRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(raf);
  }, []);

  const handleCreate = async () => {
    // 防重复提交：按钮 disabled 状态更新前的快速连击也要拦截
    if (creating) return;
    if (!selectedSkillId) {
      setError(t('chatV2:workspace.createAgent.selectSkill'));
      return;
    }
    if (!currentSessionId) {
      setError(t('chatV2:workspace.createAgent.noSession'));
      return;
    }

    // 获取选中技能的完整内容
    const selectedSkill = builtinSkills.find((s) => s.id === selectedSkillId);

    try {
      setCreating(true);
      setError(null);

      await createAgent({
        workspace_id: workspaceId,
        requester_session_id: currentSessionId,
        skill_id: selectedSkillId,
        role: 'worker',
        initial_task: initialTask.trim() || undefined,
        // 传递技能的系统提示词（来自前端 skills 系统）
        system_prompt: selectedSkill?.content,
      });

      // 创建成功后主动刷新 agents 列表，不依赖事件
      try {
        const agentsData = await listAgents(currentSessionId, workspaceId);
        const convertedAgents: WorkspaceAgent[] = agentsData.map((a) => ({
          sessionId: a.session_id,
          workspaceId: workspaceId,
          role: a.role as WorkspaceAgent['role'],
          skillId: a.skill_id,
          status: a.status as WorkspaceAgent['status'],
          joinedAt: a.joined_at,
          lastActiveAt: a.last_active_at,
          metadata: agentMetadataFromInfo(a),
          // 🆕 C12: inbox 未消费消息数
          pendingInboxCount: a.pending_inbox_count,
        }));
        const currentWorkspaceId = useWorkspaceStore.getState().currentWorkspaceId;
        if (!currentWorkspaceId || currentWorkspaceId !== workspaceId) {
          console.warn(
            '[CreateAgentCard] Skip agents refresh due to workspace switch:',
            currentWorkspaceId,
            workspaceId
          );
        } else {
          useWorkspaceStore.getState().setAgents(convertedAgents);
        }
      } catch (refreshErr: unknown) {
        console.warn('[CreateAgentCard] Failed to refresh agents list:', refreshErr);
        // 不阻止收起卡片，事件监听会补充更新
      }

      // 成功后重置表单并收起
      setSelectedSkillId(null);
      setInitialTask('');
      onClose();
    } catch (err: unknown) {
      console.error('[CreateAgentCard] Failed to create agent:', err);
      setError(
        err instanceof Error
          ? err.message
          : t('chatV2:workspace.createAgent.error')
      );
    } finally {
      setCreating(false);
    }
  };

  // 收起（取消按钮 / Escape）时保留已选技能与任务输入，避免误触丢失未提交内容；
  // 仅清除错误提示。成功创建后才重置表单（见 handleCreate）。
  const handleClose = () => {
    if (!creating) {
      setError(null);
      onClose();
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      handleClose();
    }
  };

  const titleId = `create-agent-title-${workspaceId}`;
  const descId = `create-agent-desc-${workspaceId}`;

  return (
    <div
      ref={cardRef}
      role="group"
      aria-labelledby={titleId}
      aria-describedby={descId}
      aria-busy={creating || undefined}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className={cn(
        'ui-rise-in rounded-[var(--chat-radius-md,12px)] border border-border bg-card p-3 space-y-3',
        'shadow-[var(--shadow-shell-soft)] focus:outline-none',
        className
      )}
      data-testid="create-agent-card"
    >
      {/* 头部：标题 + 收起按钮 */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <div id={titleId} className="text-sm font-medium flex items-center gap-1.5">
            <Plus size={14} className="text-primary" aria-hidden="true" />
            {t('chatV2:workspace.createAgent.title')}
          </div>
          <p id={descId} className="text-xs text-muted-foreground">
            {t('chatV2:workspace.createAgent.description')}
          </p>
        </div>
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          className="!h-6 !w-6 shrink-0"
          onClick={handleClose}
          disabled={creating}
          aria-label={t('chatV2:workspace.createAgent.cancel')}
          title={t('chatV2:workspace.createAgent.cancel')}
        >
          <X size={14} className="text-muted-foreground" />
        </DsButton>
      </div>

      {/* 技能选择 */}
      <div className="space-y-1.5">
        <Label className="text-xs">{t('chatV2:workspace.createAgent.skill')}</Label>
        <CustomScrollArea
          fullHeight={false}
          className="max-h-44 rounded-[var(--chat-radius-sm,8px)] border border-border/60"
          viewportClassName="max-h-44 p-1.5"
        >
          <div className="space-y-0.5">
            {builtinSkills.map((skill) => (
              <DsButton
                key={skill.id}
                variant="ghost"
                size="sm"
                onClick={() => !creating && setSelectedSkillId(skill.id)}
                disabled={creating}
                aria-pressed={selectedSkillId === skill.id}
                className={cn(
                  'w-full !justify-start !p-2 text-left !h-auto transition-colors',
                  selectedSkillId === skill.id && 'bg-primary/10 ring-1 ring-inset ring-primary/50',
                  creating && 'opacity-50'
                )}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{getLocalizedSkillName(skill.id, skill.name, t)}</span>
                    <span className="text-xs text-muted-foreground">v{skill.version}</span>
                    {selectedSkillId === skill.id && (
                      <Check size={16} className="text-primary ml-auto" aria-hidden="true" />
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                    {getLocalizedSkillDescription(skill.id, skill.description, t)}
                  </p>
                </div>
              </DsButton>
            ))}
            {builtinSkills.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">
                {t('chatV2:workspace.createAgent.noSkills')}
              </p>
            )}
          </div>
        </CustomScrollArea>
      </div>

      {/* 初始任务 */}
      <div className="space-y-1.5">
        <Label htmlFor={`initial-task-${workspaceId}`} className="text-xs">
          {t('chatV2:workspace.createAgent.task')}
          <span className="text-muted-foreground ml-1">
            ({t('chatV2:workspace.createAgent.taskOptional')})
          </span>
        </Label>
        <Textarea
          id={`initial-task-${workspaceId}`}
          placeholder={t('chatV2:workspace.createAgent.taskPlaceholder')}
          value={initialTask}
          onChange={(e) => setInitialTask(e.target.value)}
          disabled={creating}
          rows={3}
          className="resize-none text-sm"
        />
        <p className="text-xs text-muted-foreground">
          {t('chatV2:workspace.createAgent.taskHint')}
        </p>
      </div>

      {/* 错误提示 */}
      {error && (
        <div
          role="alert"
          className="text-xs text-destructive bg-destructive/10 px-2.5 py-1.5 rounded-[var(--chat-radius-sm,8px)]"
        >
          {error}
        </div>
      )}

      {/* 操作区 */}
      <div className="flex items-center justify-end gap-2">
        <DsButton variant="ghost" size="sm" onClick={handleClose} disabled={creating}>
          {t('chatV2:workspace.createAgent.cancel')}
        </DsButton>
        <DsButton
          variant="primary"
          size="sm"
          onClick={handleCreate}
          disabled={creating || !selectedSkillId || !currentSessionId}
        >
          {creating && <CircleNotch size={12} className="mr-1 animate-spin" aria-hidden="true" />}
          {creating
            ? t('chatV2:workspace.createAgent.creating')
            : t('chatV2:workspace.createAgent.create')}
        </DsButton>
      </div>
    </div>
  );
};

export default CreateAgentCard;

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/shad/Dialog';
import { NotionButton } from '@/components/ui/NotionButton';
import { Textarea } from '@/components/ui/shad/Textarea';
import { Label } from '@/components/ui/shad/Label';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { cn } from '@/lib/utils';
import { Check } from 'lucide-react';
import { createAgent, listAgents } from '../api';
import { useWorkspaceStore } from '../workspaceStore';
import type { WorkspaceAgent } from '../types';
import { useSkillsByLocation } from '../../skills/hooks/useSkillList';
import { getLocalizedSkillDescription, getLocalizedSkillName } from '../../skills/utils';

interface CreateAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  currentSessionId?: string;
}

export const CreateAgentDialog: React.FC<CreateAgentDialogProps> = ({
  open,
  onOpenChange,
  workspaceId,
  currentSessionId,
}) => {
  const { t } = useTranslation();
  const builtinSkills = useSkillsByLocation('builtin');
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [initialTask, setInitialTask] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
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

      const result = await createAgent({
        workspace_id: workspaceId,
        requester_session_id: currentSessionId,
        skill_id: selectedSkillId,
        role: 'worker',
        initial_task: initialTask.trim() || undefined,
        // 传递技能的系统提示词（来自前端 skills 系统）
        system_prompt: selectedSkill?.content,
      });

      console.log('[CreateAgentDialog] Agent created:', result);

      // 🔧 修复：创建成功后主动刷新 agents 列表，不依赖事件
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
        }));
        const currentWorkspaceId = useWorkspaceStore.getState().currentWorkspaceId;
        if (!currentWorkspaceId || currentWorkspaceId !== workspaceId) {
          console.warn(
            '[CreateAgentDialog] Skip agents refresh due to workspace switch:',
            currentWorkspaceId,
            workspaceId
          );
        } else {
          useWorkspaceStore.getState().setAgents(convertedAgents);
          console.log('[CreateAgentDialog] Agents list refreshed:', convertedAgents.length);
        }
      } catch (refreshErr: unknown) {
        console.warn('[CreateAgentDialog] Failed to refresh agents list:', refreshErr);
        // 不阻止关闭对话框，事件监听会补充更新
      }

      // 重置表单
      setSelectedSkillId(null);
      setInitialTask('');
      onOpenChange(false);
    } catch (err: unknown) {
      console.error('[CreateAgentDialog] Failed to create agent:', err);
      setError(
        err instanceof Error
          ? err.message
          : t('chatV2:workspace.createAgent.error')
      );
    } finally {
      setCreating(false);
    }
  };

  const handleClose = () => {
    if (!creating) {
      setSelectedSkillId(null);
      setInitialTask('');
      setError(null);
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>
            {t('chatV2:workspace.createAgent.title')}
          </DialogTitle>
          <DialogDescription>
            {t('chatV2:workspace.createAgent.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="space-y-2">
            <Label>{t('chatV2:workspace.createAgent.skill')}</Label>
            <CustomScrollArea className="h-48 border rounded-md p-2">
              <div className="space-y-1">
                {builtinSkills.map((skill) => (
                  <NotionButton
                    key={skill.id}
                    variant="ghost"
                    size="sm"
                    onClick={() => !creating && setSelectedSkillId(skill.id)}
                    disabled={creating}
                    className={cn(
                      'w-full !justify-start !p-2 text-left !h-auto',
                      selectedSkillId === skill.id && 'bg-primary/10 border border-primary',
                      creating && 'opacity-50'
                    )}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{getLocalizedSkillName(skill.id, skill.name, t)}</span>
                        <span className="text-xs text-muted-foreground">v{skill.version}</span>
                        {selectedSkillId === skill.id && (
                          <Check className="w-4 h-4 text-primary ml-auto" />
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                        {getLocalizedSkillDescription(skill.id, skill.description, t)}
                      </p>
                    </div>
                  </NotionButton>
                ))}
                {builtinSkills.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    {t('chatV2:workspace.createAgent.noSkills')}
                  </p>
                )}
              </div>
            </CustomScrollArea>
          </div>

          <div className="space-y-2">
            <Label htmlFor="initial-task">
              {t('chatV2:workspace.createAgent.task')}
              <span className="text-muted-foreground ml-1">
                ({t('chatV2:workspace.createAgent.taskOptional')})
              </span>
            </Label>
            <Textarea
              id="initial-task"
              placeholder={t('chatV2:workspace.createAgent.taskPlaceholder')}
              value={initialTask}
              onChange={(e) => setInitialTask(e.target.value)}
              disabled={creating}
              rows={3}
              className="resize-none"
            />
            <p className="text-xs text-muted-foreground">
              {t('chatV2:workspace.createAgent.taskHint')}
            </p>
          </div>

          {error && (
            <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <NotionButton variant="ghost" onClick={handleClose} disabled={creating}>
            {t('chatV2:workspace.createAgent.cancel')}
          </NotionButton>
          <NotionButton onClick={handleCreate} disabled={creating || !selectedSkillId || !currentSessionId}>
            {creating
              ? t('chatV2:workspace.createAgent.creating')
              : t('chatV2:workspace.createAgent.create')}
          </NotionButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

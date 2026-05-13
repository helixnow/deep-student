import React from 'react';
import { useTranslation } from 'react-i18next';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import type { WorkspaceMessage, WorkspaceAgent } from '../types';
import { WorkspaceMessageItem } from './WorkspaceMessageItem';

interface WorkspaceTimelineProps {
  messages: WorkspaceMessage[];
  agents?: WorkspaceAgent[];
  currentAgentId?: string;
  /** 🆕 2026-01-20: 点击查看完整会话的回调 */
  onViewFullSession?: (sessionId: string) => void;
}

export const WorkspaceTimeline: React.FC<WorkspaceTimelineProps> = ({
  messages,
  agents = [],
  currentAgentId,
  onViewFullSession,
}) => {
  const { t } = useTranslation();
  const agentMap = React.useMemo(() => {
    const map = new Map<string, { role: WorkspaceAgent['role']; skillId?: string }>();
    for (const agent of agents) {
      map.set(agent.sessionId, { role: agent.role, skillId: agent.skillId });
    }
    return map;
  }, [agents]);
  const sortedMessages = [...messages].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  // 🔧 修复：空态文案 i18n
  if (sortedMessages.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
        {t('chatV2:workspace.noMessages', '暂无消息')}
      </div>
    );
  }

  return (
    <CustomScrollArea className="h-full">
      <div className="flex flex-col gap-2 p-2">
        {sortedMessages.map((message) => (
          <WorkspaceMessageItem
            key={message.id}
            message={message}
            isFromCurrentAgent={message.senderSessionId === currentAgentId}
            onViewFullSession={onViewFullSession}
            agentMap={agentMap}
          />
        ))}
      </div>
    </CustomScrollArea>
  );
};

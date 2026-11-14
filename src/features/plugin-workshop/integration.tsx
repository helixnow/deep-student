import React from 'react';
import type { ChatToolResultContribution, ChatToolResultProps } from '@/ui-kernel/contracts/chat';
import { useRefreshOnReturn } from '@/hooks/useRefreshOnReturn';
import { getErrorMessage } from '@/utils/errorUtils';
import { WorkshopCreations } from './WorkshopCreations';
import { WorkshopProposalCard } from './components/WorkshopProposalCard';
import { useWorkshop } from './useWorkshop';
import { openWorkshopSession, type WorkshopSessionPort } from './session';
import type { WorkshopAdapter } from './types';

function proposalId(output: unknown, depth = 0): string | undefined {
  if (depth > 4 || !output) return;
  if (typeof output === 'string') {
    try { return proposalId(JSON.parse(output), depth + 1); } catch { return; }
  }
  if (typeof output !== 'object') return;
  const record = output as Record<string, unknown>;
  if (record.kind === 'dstu-plugin-workshop' && typeof record.id === 'string') return record.id;
  for (const key of ['result', 'output', 'content', 'data'] as const) {
    if (record[key]) {
      const nested = proposalId(record[key], depth + 1);
      if (nested) return nested;
    }
  }
  return;
}

function Creations({ adapter, modify }: { adapter: WorkshopAdapter; modify: (id: string) => void }) {
  const state = useWorkshop(adapter);
  return <>
    {state.items.filter(item => ['proposed', 'ready', 'generating', 'failed'].includes(item.phase)).map(item =>
      <WorkshopProposalCard key={item.proposalId} item={item} busy={state.busyId === item.id} onAction={action => { void state.act(action, item); }} onRepair={() => modify(item.id)} />)}
    <WorkshopCreations {...state} onAction={(action, item) => { void state.act(action, item); }} onModify={item => modify(item.id)} />
    {state.exportPath && <p role="status" className="break-all text-sm text-muted-foreground">已导出：{state.exportPath}</p>}
  </>;
}

function Proposal({ adapter, id, modify }: { adapter: WorkshopAdapter; id: string; modify: (pluginId: string) => void }) {
  const state = useWorkshop(adapter);
  useRefreshOnReturn(state.refresh, !state.loading);
  const item = state.items.find(entry => entry.proposalId === id);
  // Never trust toolOutput as current authority after reopening a conversation.
  if (!item) return <div role="status" className="space-y-2 text-sm text-muted-foreground">
    <p>{state.error ?? (state.loading ? '正在读取工坊状态…' : '未找到此作品，可到「我的创作」查看。')}</p>
  </div>;
  return <WorkshopProposalCard embedded item={item} busy={state.busyId === item.id} error={state.error} exportPath={state.exportPath} onAction={action => { void state.act(action, item); }} onRepair={() => modify(item.id)} />;
}

export interface WorkshopIntegrationOptions {
  adapter: WorkshopAdapter;
  sessions: WorkshopSessionPort;
  reportError: (message: string) => void;
}

/** Root composition passes this structural object to P2, and contributes toolResult under the paired UI owner. */
export function createWorkshopIntegration({ adapter, sessions, reportError }: WorkshopIntegrationOptions) {
  let entering = false;
  const enter = async (pluginId?: string) => {
    if (entering) return;
    entering = true;
    try {
      const item = pluginId ? (await adapter.list()).find(entry => entry.id === pluginId) : undefined;
      if (pluginId && !item) throw new Error('只能修改插件工坊托管的作品。请先在“我的创作”中选择作品。');
      if (item && item.revision === undefined) throw new Error('WORKSHOP_CONFLICT: 请刷新作品后再修改');
      await openWorkshopSession(sessions, item ? { pluginId: item.id, version: item.version, workshopId: item.proposalId, revision: item.revision! } : undefined);
    } catch (error) { reportError(getErrorMessage(error)); }
    finally { entering = false; }
  };
  const onCreate = () => { void enter(); };
  const onModify = (id: string) => { void enter(id); };
  const onRollback = async (pluginId: string) => {
    const item = (await adapter.list()).find(entry => entry.id === pluginId);
    if (!item) throw new Error('只能回退插件工坊托管的作品。');
    await adapter.act(item.phase === 'undone' ? 'restore' : 'undo', item);
  };
  const ToolResult = ({ toolOutput }: ChatToolResultProps) => {
    const id = proposalId(toolOutput);
    return id ? <Proposal key={id} adapter={adapter} id={id} modify={onModify} /> : null;
  };
  const toolResult: ChatToolResultContribution = {
    placement: 'output', component: ToolResult, match: 'qualified',
    when: props => Boolean(proposalId(props.toolOutput)),
  };
  return {
    workshop: { onCreate, onModify, onRollback, creations: <Creations adapter={adapter} modify={onModify} /> },
    toolResult,
  };
}

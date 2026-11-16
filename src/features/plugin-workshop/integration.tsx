import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatToolResultContribution, ChatToolResultProps } from '@/ui-kernel/contracts/chat';
import { useRefreshOnReturn } from '@/hooks/useRefreshOnReturn';
import { getErrorMessage } from '@/utils/errorUtils';
import { WorkshopCreations } from './WorkshopCreations';
import { WorkshopProposalCard } from './components/WorkshopProposalCard';
import { workshopErrorText, workshopPhaseKey, workshopProgressText } from './WorkshopConfirmationCard';
import { DsButton } from '@/components/ui/DsButton';
import { workshopCardView } from './host-adapter';
import { useWorkshop } from './useWorkshop';
import { openWorkshopSession, type WorkshopSessionPort } from './session';
import { phaseOfWireState, publishWorkshopStage, useWorkshopStage } from './stage';
import type { WorkshopAdapter, WorkshopItem } from './types';

type Translate = (key: string, options?: Record<string, unknown>) => string;

function workshopRecord(output: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > 4 || !output) return;
  if (typeof output === 'string') {
    try { return workshopRecord(JSON.parse(output), depth + 1); } catch { return; }
  }
  if (typeof output !== 'object') return;
  const record = output as Record<string, unknown>;
  if (record.kind === 'dstu-plugin-workshop' && typeof record.id === 'string') return record;
  for (const key of ['result', 'output', 'content', 'data'] as const) {
    if (record[key]) {
      const nested = workshopRecord(record[key], depth + 1);
      if (nested) return nested;
    }
  }
  return;
}
const proposalId = (output: unknown) => workshopRecord(output)?.id as string | undefined;
/** The record revision the tool output was made at: which proposal this chat card belongs to. */
const proposalRevisionOf = (output: unknown): number | undefined => {
  const record = workshopRecord(output);
  const value = record?.proposalRevision ?? record?.revision;
  return typeof value === 'number' ? value : undefined;
};
/** The work belongs to another conversation: the card offers 「在这个对话里修改『X』」 (F19). */
const bindRequiredOf = (output: unknown): boolean => Boolean(workshopRecord(output)?.bindRequired);
const stageKey = (id: string, revision: number | undefined) => `${id}@${revision ?? ''}`;
/** Failed works untouched for this long collapse into one line in 「工坊创作记录」. */
const OLD_FAILURE_MS = 7 * 24 * 60 * 60 * 1000;

/** The sentence put in the composer for a change or a fix; never sent on the user's behalf. */
export function workshopEditPrompt(t: Translate, item: Pick<WorkshopItem, 'name'>): string {
  return t('workshop.editPrompt', { name: item.name });
}

/** Phases that need the user (or are in progress): shown as the full card, once, in place of a row. */
const ACTIVE_PHASES = ['proposed', 'ready', 'generating', 'editing', 'validating', 'installing', 'failed'];

/**
 * 「工坊创作记录」 in the manager, read as one thing: the explanation first, then each work once.
 * Waiting / in-progress / failed works are full cards; uninstalled ones are rows with 恢复. Installed and turned-off
 * works are not repeated here — 「我的插件」 above already shows them as cards.
 */
function Creations({ adapter, modify }: { adapter: WorkshopAdapter; modify: (id: string) => void }) {
  const { t } = useTranslation('plugin_manager');
  const state = useWorkshop(adapter);
  const [showOld, setShowOld] = useState(false);
  const now = Date.now();
  // A failure nobody touched for a week is history: one line (and a way to clear it), not a full card each.
  const old = (item: WorkshopItem) => item.phase === 'failed' && !item.installed && item.updatedAt !== undefined
    && now - Date.parse(item.updatedAt) > OLD_FAILURE_MS;
  const oldFailures = state.items.filter(old);
  const active = state.items.filter(item => ACTIVE_PHASES.includes(item.phase) && (showOld || !old(item)));
  const restorable = state.items.filter(item => item.phase === 'undone');
  const clearOld = async () => { for (const item of oldFailures) await state.act('discard', item); };
  return <div className="min-w-0 space-y-3" data-testid="workshop-creations-section">
    <p className="px-1 text-xs leading-relaxed text-muted-foreground">{t('workshop.creationsDescription')}</p>
    {oldFailures.length > 0 && (
      <div className="flex flex-wrap items-center gap-2 px-1 text-xs text-muted-foreground" data-testid="workshop-old-failures">
        <span>{t('workshop.oldFailures', { count: oldFailures.length })}</span>
        <DsButton size="sm" variant="ghost" data-testid="workshop-old-failures-toggle" onClick={() => setShowOld(open => !open)}>
          {t(showOld ? 'workshop.actions.hide' : 'workshop.actions.show')}
        </DsButton>
        <DsButton size="sm" variant="ghost" disabled={state.busyId !== undefined} data-testid="workshop-old-failures-clear" onClick={() => { void clearOld(); }}>
          {t('workshop.actions.discardAll')}
        </DsButton>
      </div>
    )}
    {active.map(item =>
      <WorkshopProposalCard key={item.proposalId} item={item} busy={state.busyId === item.id} onAction={(action, input) => { void (input ? state.act(action, item, input) : state.act(action, item)); }}
        onRepair={() => modify(item.id)} onRefresh={() => { void state.refresh(); }} />)}
    {restorable.length > 0 || state.loading || state.error || !active.length
      ? <WorkshopCreations {...state} items={restorable} showDescription={false} emptyHidden={active.length > 0}
        onAction={(action, item) => { void state.act(action, item); }} onModify={item => modify(item.id)} />
      : null}
  </div>;
}

interface ProposalProps {
  adapter: WorkshopAdapter;
  id: string;
  /** The record revision of the proposal this card shows (from its tool output). */
  viewRevision?: number;
  /** This conversation (the card's own); 「让 AI 改」 stays here. */
  sessionId?: string;
  sessions: WorkshopSessionPort;
  modify: (pluginId: string) => void;
  /** The AI wants to change a work made in another conversation: offer to move editing here. */
  bindRequired?: boolean;
}

/** 「在这个对话里修改『X』」: the user's click binds the work to this conversation; then the AI can propose the change. */
function BindHere({ item, sessionId, busy, onBind }: { item: WorkshopItem; sessionId: string; busy?: boolean; onBind: () => void }) {
  const { t } = useTranslation('plugin_manager');
  const bound = item.sessionId === sessionId || (item.boundSessions ?? []).includes(sessionId);
  if (bound) return <p role="status" data-testid="workshop-bound-here" className="text-sm text-muted-foreground">{t('workshop.boundHere', { name: item.name })}</p>;
  return (
    <div className="space-y-1.5" data-testid="workshop-bind">
      <p className="text-sm text-muted-foreground">{t('workshop.bindExplain', { name: item.name })}</p>
      <DsButton size="sm" variant="outline" disabled={busy} data-testid="workshop-bind-here" onClick={onBind}>{t('workshop.actions.bindHere', { name: item.name })}</DsButton>
    </div>
  );
}

function Proposal({ adapter, id, viewRevision, sessionId, sessions, modify, bindRequired }: ProposalProps) {
  const { t } = useTranslation('plugin_manager');
  const state = useWorkshop(adapter);
  useRefreshOnReturn(state.refresh, !state.loading);
  // 「按新版重做」 pressed on this card: it follows the new proposal it started.
  const [followLatest, setFollowLatest] = useState(false);
  const found = state.items.find(entry => entry.proposalId === id);
  const item = found ? workshopCardView(found, followLatest ? undefined : viewRevision) : undefined;
  // Keyed by card (record + its proposal revision): two cards of one work can show different steps.
  useEffect(() => { if (item) publishWorkshopStage(stageKey(id, viewRevision), { phase: item.phase, progress: item.progress, labelKey: workshopPhaseKey(item) }); }, [id, viewRevision, item]);
  // Never trust toolOutput as current authority after reopening a conversation.
  if (!item) return <div role="status" className="space-y-2 text-sm text-muted-foreground">
    <p>{state.loading ? t('workshop.loading') : t('workshop.notFound')}</p>
  </div>;
  const repairHere = () => {
    // Same conversation: focus its composer with the sentence ready to finish. Without a known session, fall back
    // to the manager path (the conversation that owns the work).
    if (!sessionId || !sessions.prefill) { modify(item.id); return; }
    const text = item.phase === 'failed' ? t('workshop.repairPrompt', { name: item.name }) : workshopEditPrompt(t, item);
    void Promise.resolve(sessions.prefill(sessionId, text)).then(() => sessions.focus?.(sessionId));
  };
  const reveal = adapter.reveal;
  if (bindRequired && sessionId) {
    const bind = () => {
      void state.act('bind', item, { sessionId }).then(() => {
        if (!sessions.prefill) return;
        return Promise.resolve(sessions.prefill(sessionId, workshopEditPrompt(t, item))).then(() => sessions.focus?.(sessionId));
      });
    };
    return <div className="space-y-2.5">
      <BindHere item={item} sessionId={sessionId} busy={state.busyId === item.id} onBind={bind} />
    </div>;
  }
  return <WorkshopProposalCard embedded item={item} busy={state.busyId === item.id} error={state.error} exportPath={state.exportPath}
    onReveal={reveal ? path => { void reveal(path).catch(cause => console.error('[plugin-workshop] reveal failed', cause)); } : undefined}
    onAction={(action, input) => {
      if (action === 'redo') setFollowLatest(true);
      void (input ? state.act(action, item, input) : state.act(action, item));
    }} onRepair={repairHere} onRefresh={() => { void state.refresh(); }} />;
}

/** The chat tool header's stage: 「等你确认」/「正在做」/「已安装」 instead of "执行完成 700ms". */
function ToolStatus({ toolOutput }: ChatToolResultProps) {
  const { t } = useTranslation('plugin_manager');
  const record = workshopRecord(toolOutput);
  const stage = useWorkshopStage(typeof record?.id === 'string' ? stageKey(record.id, proposalRevisionOf(toolOutput)) : undefined);
  const phase = stage?.phase ?? phaseOfWireState(record?.state);
  if (!phase) return null;
  const text = stage?.progress ? workshopProgressText(t, stage.progress) : t(stage?.labelKey ?? `workshop.phase.${phase}`);
  return <span data-testid="workshop-tool-stage" data-phase={phase}>{text}</span>;
}

export interface WorkshopIntegrationOptions {
  adapter: WorkshopAdapter;
  sessions: WorkshopSessionPort;
  /** Receives raw error text; the root translates it (describeWorkshopError) before showing it. */
  reportError: (message: string) => void;
  /** Translator for the composer sentence and the editing strip (defaults to the zh-CN wording). */
  translate?: Translate;
}

const zhFallback: Translate = (key, options) => key === 'workshop.editPrompt'
  ? `把『${String(options?.name ?? '')}』改成：`
  : key === 'workshop.editing' ? `正在修改：${String(options?.name ?? '')} v${String(options?.version ?? '')}` : key;

/** Root composition passes this structural object to P2, and contributes toolResult under the paired UI owner. */
export function createWorkshopIntegration({ adapter, sessions, reportError, translate = zhFallback }: WorkshopIntegrationOptions) {
  let entering = false;
  const managed = async (pluginId: string) => {
    const item = (await adapter.list()).find(entry => entry.id === pluginId);
    if (!item) throw new Error('WORKSHOP_ONLY_MANAGED: only workshop-managed works can be changed here');
    return item;
  };
  const enter = async (pluginId?: string, prompt?: string) => {
    if (entering) return;
    entering = true;
    try {
      if (!pluginId) { await openWorkshopSession(sessions, undefined, prompt); return; }
      const item = await managed(pluginId);
      if (item.revision === undefined) throw new Error('WORKSHOP_CONFLICT: card has no revision; refresh it');
      const text = workshopEditPrompt(translate, item);
      const editing = item.version ? translate('workshop.editing', { name: item.name, version: item.version }) : null;
      // Prefer the conversation that already owns this work; it remembers how the work was made.
      const owner = item.sessionId && sessions.exists ? (await sessions.exists(item.sessionId) ? item.sessionId : undefined) : undefined;
      if (owner) {
        sessions.setEditing?.(owner, editing);
        await sessions.prefill?.(owner, text);
        sessions.navigate(owner);
        sessions.focus?.(owner);
        return;
      }
      const sessionId = await openWorkshopSession(sessions, { pluginId: item.id, version: item.version, workshopId: item.proposalId, revision: item.revision }, text);
      sessions.setEditing?.(sessionId, editing);
      sessions.focus?.(sessionId);
    } catch (error) { reportError(getErrorMessage(error)); }
    finally { entering = false; }
  };
  const onCreate = (prompt?: string) => { void enter(undefined, prompt); };
  const onModify = (id: string) => { void enter(id); };
  const onRollback = async (pluginId: string) => {
    const item = await managed(pluginId);
    if (item.installed?.phase !== 'undone' && !item.installed?.previousVersion) throw new Error('WORKSHOP_STATE: no successful version retained');
    await adapter.act('restore', item);
  };
  // RUST-FIX(RF-P6-manager-cards): version facts and file export for the manager's cards; Host stays authoritative.
  // The manager shows what is installed: a modification proposed or in progress does not change these facts.
  const installedPhases = ['installed', 'disabled'];
  const works = async () => (await adapter.list()).filter(entry => entry.installed && installedPhases.includes(entry.installed.phase)).map(entry => ({
    pluginId: entry.id, version: entry.installed!.version, changes: entry.proposal && entry.phase !== entry.installed!.phase ? [] : entry.changes,
    ...(entry.installed!.previousVersion ? { previousVersion: entry.installed!.previousVersion } : {}),
  }));
  /** Works waiting for the user (to confirm or to start); the manager opens 「工坊创作记录」 when there are any. */
  const pending = async () => (await adapter.list()).filter(entry => entry.phase === 'ready' || entry.phase === 'proposed')
    .map(entry => ({ pluginId: entry.id, name: entry.name, phase: entry.phase }));
  const onRestorePrevious = async (pluginId: string) => {
    const item = await managed(pluginId);
    if (!item.installed || !installedPhases.includes(item.installed.phase) || !item.installed.previousVersion) throw new Error('WORKSHOP_STATE: no successful version retained');
    await adapter.act('restore', item);
  };
  /** The manager's 卸载 for a workshop work goes through the workshop, so the chat card and the record stay in sync. */
  const onUninstall = async (pluginId: string) => {
    const item = await managed(pluginId);
    await adapter.act('undo', item);
  };
  /** Where the file went; null when the user cancelled the save dialog. */
  const onExport = async (pluginId: string) => {
    const item = await managed(pluginId);
    return (await adapter.act('export', item)).exportPath ?? null;
  };
  const reveal = adapter.reveal;
  const onReveal = reveal ? (path: string) => { void reveal(path).catch(error => reportError(getErrorMessage(error))); } : undefined;
  /** Host workshop errors in the user's words, for the manager (which never shows raw WORKSHOP_* text). */
  const describeError = (raw: string) => workshopErrorText(translate, raw);
  const ToolResult = (props: ChatToolResultProps) => {
    const id = proposalId(props.toolOutput);
    const sessionId = (props.store?.getState() as { sessionId?: string } | undefined)?.sessionId;
    return id ? <Proposal key={id} adapter={adapter} id={id} viewRevision={proposalRevisionOf(props.toolOutput)} sessionId={sessionId} sessions={sessions} modify={onModify}
      bindRequired={bindRequiredOf(props.toolOutput)} /> : null;
  };
  const toolResult: ChatToolResultContribution = {
    placement: 'output', component: ToolResult, status: ToolStatus, match: 'qualified',
    when: props => Boolean(proposalId(props.toolOutput)),
  };
  return {
    workshop: { onCreate, onModify, onRollback, works, pending, onRestorePrevious, onUninstall, onExport, describeError,
      ...(onReveal ? { onReveal } : {}), creations: <Creations adapter={adapter} modify={onModify} /> },
    toolResult,
  };
}

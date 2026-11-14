import {
  usePinnedArtifactStore,
  type PinnedArtifactKind,
  type PinnedArtifactRecord,
} from '@/stores/pinnedArtifactStore';
import {
  resolveTargetSandboxOwnerKey,
  useSandboxWorkbenchStore,
} from './store/useSandboxWorkbenchStore';
import type { SandboxOwnerKey, SandboxSessionInput } from './types';

export interface PinArtifactToCanvasInput {
  kind?: PinnedArtifactKind;
  artifactKind?: PinnedArtifactKind;
  language: string;
  title: string;
  content: string;
  sourceMessageId?: string;
  widgetId?: string;
  sessionId?: string;
  groupId?: string;
  patchSummary?: string;
}

export function launchSandboxWorkbench(
  input: SandboxSessionInput,
  ownerKey?: SandboxOwnerKey,
): void {
  const state = useSandboxWorkbenchStore.getState();
  // Pointer/focus capture updates activeOwnerKey before CodeBlock's click handler.
  // Prefer it over document.activeElement, which can remain in another window on WebKit.
  const resolvedOwnerKey = resolveTargetSandboxOwnerKey(state, ownerKey, input.sessionId);
  state.openSession(input, resolvedOwnerKey);
}

export function pinArtifactToCanvas(
  input: PinArtifactToCanvasInput,
  ownerKey?: SandboxOwnerKey,
): PinnedArtifactRecord {
  const state = useSandboxWorkbenchStore.getState();
  const resolvedOwnerKey = resolveTargetSandboxOwnerKey(state, ownerKey, input.sessionId);
  const resolvedKind: PinnedArtifactKind = input.artifactKind ?? input.kind ?? 'html';
  const record = usePinnedArtifactStore.getState().upsertPinnedArtifact({
    ownerKey: resolvedOwnerKey,
    sessionId: input.sessionId,
    groupId: input.groupId,
    widgetId: input.widgetId,
    kind: resolvedKind,
    language: input.language,
    title: input.title,
    sourceMessageId: input.sourceMessageId || 'chat-code-block',
    content: input.content,
    patchSummary: input.patchSummary,
  });
  const activeRevision =
    record.revisions.find((rev) => rev.version === record.activeVersion) ??
    record.revisions[record.revisions.length - 1];

  state.openSession(
    {
      sourceType: resolvedKind === 'generative-ui' ? 'chat-generative-ui' : 'chat-code-block',
      sourceMessageId: record.sourceMessageId,
      language: record.language,
      title: record.title,
      content: activeRevision?.content ?? input.content,
      artifactKind: record.kind,
      widgetId: record.widgetId,
      sessionId: record.sessionId,
      groupId: record.groupId,
      artifactId: record.artifactId,
      initialMode: record.kind === 'html' ? 'sandbox-run' : 'safe-preview',
    },
    resolvedOwnerKey,
  );

  return record;
}

export default launchSandboxWorkbench;

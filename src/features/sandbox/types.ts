import type { PinnedArtifactKind } from '@/stores/pinnedArtifactStore';

export type SandboxSourceType = 'chat-code-block' | 'chat-generative-ui';

export type SandboxWorkbenchMode = 'safe-preview' | 'sandbox-run';

export type SandboxViewportPreset = 'desktop' | 'tablet' | 'mobile';

export type SandboxOwnerKey = string;

export interface SandboxSessionInput {
  sourceType: SandboxSourceType;
  sourceMessageId: string;
  language: string;
  title: string;
  content: string;
  artifactKind?: PinnedArtifactKind;
  widgetId?: string;
  sessionId?: string;
  groupId?: string;
  artifactId?: string;
  initialMode?: SandboxWorkbenchMode;
}

export interface SandboxSession extends SandboxSessionInput {
  id: string;
  mode: SandboxWorkbenchMode;
  createdAt: number;
  updatedAt: number;
}

export interface SandboxWorkbenchOwnerState {
  activeSession: SandboxSession | null;
  isOpen: boolean;
  viewportPreset: SandboxViewportPreset;
  inspectorOpen: boolean;
}

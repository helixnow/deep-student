export type SandboxSourceType = 'chat-code-block';

export type SandboxWorkbenchMode = 'safe-preview' | 'sandbox-run';

export type SandboxViewportPreset = 'desktop' | 'tablet' | 'mobile';

export interface SandboxSessionInput {
  sourceType: SandboxSourceType;
  sourceMessageId: string;
  language: string;
  title: string;
  content: string;
}

export interface SandboxSession extends SandboxSessionInput {
  id: string;
  mode: SandboxWorkbenchMode;
  createdAt: number;
  updatedAt: number;
}

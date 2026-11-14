import type {} from '@deepseek-ai/cordis';

export type WorkshopState = 'draft' | 'generating' | 'cancelled' | 'pending-confirmation' | 'installed' | 'failed' | 'revoked';
export type WorkshopTemplate = 'learning-tool' | 'host-tool';
export interface WorkshopBrief {
  sessionId: string; title: string; description: string; template: WorkshopTemplate;
  pluginId?: string; changes: string[]; capabilities: string[];
}
export interface WorkshopCheck {
  ok: boolean; manifest: 'passed' | 'failed'; compile: 'passed' | 'failed';
  lifecycle: 'passed' | 'failed' | 'not-run'; visual: 'not-verified'; errors: string[];
}
export interface WorkshopCard {
  kind: 'dstu-plugin-workshop'; id: string; pluginId: string; sessionId: string;
  title: string; description: string; template: WorkshopTemplate; state: WorkshopState;
  revision: number; version: string | null; capabilities: string[]; changes: string[];
  trust: 'full'; source: 'workshop'; risk: string; check: WorkshopCheck | null;
  error: string | null; previousVersion: string | null; createdAt: string; updatedAt: string;
  rollback?: 'not-needed' | 'restored' | 'failed';
  /** Last version observed running in the real application, not merely self-checked/installed. */
  usableVersion?: string | null;
  /** Immutable managed package last observed running; failed candidates never replace it. */
  lastGoodPackageDir?: string | null;
  buildAttempt?: number;
  lastFault?: string | null;
}
export interface WorkshopExport { id: string; version: string; path: string; }
export interface PluginWorkshopService {
  developmentSkill(includeContent?: boolean): Promise<{ id: string; markdown: string; schemaToolIds: string[] }>;
  bindSession(id: string, revision: number, sessionId: string): Promise<WorkshopCard>;
  propose(brief: WorkshopBrief): Promise<WorkshopCard>;
  list(): Promise<WorkshopCard[]>;
  status(id: string): Promise<WorkshopCard>;
  create(id: string, revision: number): Promise<WorkshopCard>;
  cancel(id: string, revision: number): Promise<WorkshopCard>;
  validate(id: string): Promise<WorkshopCheck>;
  install(id: string, revision: number): Promise<WorkshopCard>;
  revoke(id: string, revision: number): Promise<WorkshopCard>;
  restore(id: string, revision: number): Promise<WorkshopCard>;
  export(id: string): Promise<WorkshopExport>;
  reportFault(id: string, error: string): Promise<WorkshopCard>;
}
declare module '@deepseek-ai/cordis' {
  interface Context { pluginWorkshop: PluginWorkshopService; }
}

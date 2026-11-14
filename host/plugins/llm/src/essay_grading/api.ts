/** Command-level contract consumed by L15 review (Rust essay_grading/mod.rs). */
import type * as Wire from '../../../../../contracts/ipc/generated/L15-review-analytics.ts';

export interface EssayGradingService {
  stream(request: Wire.GradingRequest, emit: (event: string, payload: unknown) => void,
    signal: AbortSignal): Promise<Wire.GradingResponse | null>;
  createSession(title: string, essayType: string, gradeLevel: string, customPrompt: string | null): Promise<Wire.VfsEssaySession>;
  getSession(sessionId: string): Promise<Wire.VfsEssaySession | null>;
  updateSession(session: Wire.VfsUpdateEssaySessionParams): Promise<void>;
  deleteSession(sessionId: string): Promise<number>;
  listSessions(offset: number | null, limit: number | null, query: string | null): Promise<Wire.VfsEssaySession[]>;
  toggleFavorite(sessionId: string): Promise<boolean>;
  getRounds(sessionId: string): Promise<Wire.GradingRoundResponse[]>;
  getRound(sessionId: string, roundNumber: number): Promise<Wire.GradingRoundResponse | null>;
  getLatestRoundNumber(sessionId: string): Promise<number>;
  getModes(): Promise<Wire.GradingMode[]>;
  getMode(modeId: string): Promise<Wire.GradingMode | null>;
  createCustomMode(input: Wire.CreateModeInput): Promise<Wire.GradingMode>;
  updateCustomMode(input: Wire.UpdateModeInput): Promise<Wire.GradingMode>;
  deleteCustomMode(modeId: string): Promise<void>;
  listCustomModes(): Promise<Wire.GradingMode[]>;
  saveBuiltinOverride(input: Wire.SaveBuiltinOverrideInput): Promise<Wire.GradingMode>;
  resetBuiltinMode(builtinId: string): Promise<Wire.GradingMode>;
  hasBuiltinOverride(builtinId: string): Promise<boolean>;
  getModels(): Promise<Wire.ModelInfo[]>;
}

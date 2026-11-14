/**
 * `essay_grading_*` 命令层（Rust `src-tauri/src/essay_grading/mod.rs` 的薄包装）。
 *
 * 批改管线（LLM、VFS essay 会话、自定义模式）属于作文批改服务；本插件只保留命令名、
 * 参数名与顺序、默认值、错误类型。服务由作文批改 lane 通过 Cordis 服务
 * `essayGrading` 发布；未安装时按 Rust `VFS 数据库未初始化` 的数据库错误失败。
 */
import type { Context } from '@deepseek-ai/cordis';
import type * as Wire from '../../../../contracts/ipc/generated/L15-review-analytics.ts';
import { gradingScoreToWire, type EssayGradingService } from '../../llm/api.ts';
import { f32Atom, type JsonNumberAtom } from '../../../platform/serde-compat/index.ts';
import { appError } from './errors.ts';

export interface EssayGradingStreamEmitter {
  (event: string, payload: unknown): void;
}

export const ESSAY_GRADING_SERVICE = 'essayGrading';

export function essayGradingService(ctx: Context): EssayGradingService {
  const service = ctx.get(ESSAY_GRADING_SERVICE) as EssayGradingService | undefined;
  if (service === undefined) throw appError('Database', 'VFS 数据库未初始化');
  return service;
}

function streamEmitter(ctx: Context): EssayGradingStreamEmitter {
  return (event, payload) => ctx.backendEvents.emit(event, payload);
}

type WireScoreDimension = Omit<Wire.ScoreDimension, 'max_score'> & { max_score: JsonNumberAtom };
type WireGradingMode = Omit<Wire.GradingMode, 'total_max_score' | 'score_dimensions'> & {
  total_max_score: JsonNumberAtom; score_dimensions: WireScoreDimension[];
};

/** `GradingMode.total_max_score` / `ScoreDimension.max_score` 是 Rust `f32`，按 serde_json 拼写（`30.0`）。 */
function modeToWire(mode: Wire.GradingMode): WireGradingMode;
function modeToWire(mode: Wire.GradingMode | null): WireGradingMode | null;
function modeToWire(mode: Wire.GradingMode | null): WireGradingMode | null {
  if (mode === null) return null;
  return {
    ...mode,
    total_max_score: f32Atom(mode.total_max_score),
    score_dimensions: mode.score_dimensions.map(dim => ({ ...dim, max_score: f32Atom(dim.max_score) })),
  };
}

interface SessionIdArgs { sessionId: string }
interface ModeIdArgs { modeId: string }
interface BuiltinIdArgs { builtinId: string }
interface RoundArgs { sessionId: string; roundNumber: number }
interface ListSessionsArgs { offset?: number | null; limit?: number | null; query?: string | null }

export function registerEssayGradingCommands(ctx: Context): void {
  ctx.commands.register<{ request: Wire.GradingRequest }>('essay_grading_stream', async ({ request }, call) =>
    gradingScoreToWire(await essayGradingService(ctx).stream(request, streamEmitter(ctx), call.signal)));

  ctx.commands.register<{
    title: string; essayType: string; gradeLevel: string; customPrompt?: string | null;
  }>('essay_grading_create_session', ({ title, essayType, gradeLevel, customPrompt }) =>
    essayGradingService(ctx).createSession(title, essayType, gradeLevel, customPrompt ?? null));

  ctx.commands.register<SessionIdArgs>('essay_grading_get_session', ({ sessionId }) =>
    essayGradingService(ctx).getSession(sessionId));

  ctx.commands.register<{ session: Wire.VfsUpdateEssaySessionParams }>(
    'essay_grading_update_session', async ({ session }) => {
      await essayGradingService(ctx).updateSession(session);
      return null;
    });

  ctx.commands.register<SessionIdArgs>('essay_grading_delete_session', ({ sessionId }) =>
    essayGradingService(ctx).deleteSession(sessionId));

  ctx.commands.register<ListSessionsArgs>('essay_grading_list_sessions', ({ offset, limit, query }) =>
    essayGradingService(ctx).listSessions(offset ?? null, limit ?? null, query ?? null));

  ctx.commands.register<SessionIdArgs>('essay_grading_toggle_favorite', ({ sessionId }) =>
    essayGradingService(ctx).toggleFavorite(sessionId));

  ctx.commands.register<SessionIdArgs>('essay_grading_get_rounds', async ({ sessionId }) =>
    (await essayGradingService(ctx).getRounds(sessionId)).map(round => gradingScoreToWire(round)));

  ctx.commands.register<RoundArgs>('essay_grading_get_round', async ({ sessionId, roundNumber }) =>
    gradingScoreToWire(await essayGradingService(ctx).getRound(sessionId, roundNumber)));

  ctx.commands.register<SessionIdArgs>('essay_grading_get_latest_round_number', ({ sessionId }) =>
    essayGradingService(ctx).getLatestRoundNumber(sessionId));

  ctx.commands.register('essay_grading_get_modes', async () =>
    (await essayGradingService(ctx).getModes()).map(mode => modeToWire(mode)));

  ctx.commands.register<ModeIdArgs>('essay_grading_get_mode', async ({ modeId }) =>
    modeToWire(await essayGradingService(ctx).getMode(modeId)));

  ctx.commands.register<{ input: Wire.CreateModeInput }>('essay_grading_create_custom_mode', async ({ input }) =>
    modeToWire(await essayGradingService(ctx).createCustomMode(input)));

  ctx.commands.register<{ input: Wire.UpdateModeInput }>('essay_grading_update_custom_mode', async ({ input }) =>
    modeToWire(await essayGradingService(ctx).updateCustomMode(input)));

  ctx.commands.register<ModeIdArgs>('essay_grading_delete_custom_mode', async ({ modeId }) => {
    await essayGradingService(ctx).deleteCustomMode(modeId);
    return null;
  });

  ctx.commands.register('essay_grading_list_custom_modes', async () =>
    (await essayGradingService(ctx).listCustomModes()).map(mode => modeToWire(mode)));

  ctx.commands.register<{ input: Wire.SaveBuiltinOverrideInput }>(
    'essay_grading_save_builtin_override', async ({ input }) =>
      modeToWire(await essayGradingService(ctx).saveBuiltinOverride(input)));

  ctx.commands.register<BuiltinIdArgs>('essay_grading_reset_builtin_mode', async ({ builtinId }) =>
    modeToWire(await essayGradingService(ctx).resetBuiltinMode(builtinId)));

  ctx.commands.register<BuiltinIdArgs>('essay_grading_has_builtin_override', ({ builtinId }) =>
    essayGradingService(ctx).hasBuiltinOverride(builtinId));

  ctx.commands.register('essay_grading_get_models', () => essayGradingService(ctx).getModels());
}

/** Rust essay_grading/mod.rs command semantics; SQL stays in the published VFS repository. */
import type * as Wire from '../../../../../contracts/ipc/generated/L15-review-analytics.ts';
import { AppError, CommandError } from '../../../../platform/errors/api.ts';
import type { VfsEssay } from '../../../vfs-repos/api.ts';
import type { EssayGradingService } from './api.ts';
import { CustomModeManager, modeToWire } from './custom_modes.ts';
import { canonicalModeId, getBuiltinGradingModes } from './types.ts';
import { errorText, vfsOperation } from './errors.ts';
import { f32Json } from './f32.ts';
import { storedDimensionScoresJson } from './score_json.ts';
import { runGrading, type GradingRuntime } from './run.ts';

function sessionId(id: string): void {
  if (id.trim() === '') throw new CommandError(AppError.validation('session_id 不能为空'));
}
function modeOperation<T>(context: string, operation: () => T | Promise<T>): Promise<T> {
  return (async () => {
    try { return await operation(); }
    catch (error) { throw new CommandError(AppError.internal(`${context}: ${errorText(error)}`)); }
  })();
}
const dimensions = (items: Wire.ScoreDimension__De[]) => items.map(item => ({
  name: item.name, maxScore: item.max_score, description: item.description ?? null,
}));

export function createEssayGradingService(runtime: GradingRuntime, modes: CustomModeManager): EssayGradingService {
  const repo = runtime.repository;
  const round = (essay: VfsEssay): Wire.GradingRoundResponse => {
    const input = vfsOperation(`获取作文内容失败 (essay_id=${essay.id})`,
      () => repo.getEssayContent(runtime.connection(), essay.id)) ?? '';
    const result = essay.gradingResult;
    const object = result !== null && typeof result === 'object' && !Array.isArray(result) ? result : undefined;
    return {
      id: essay.id, session_id: essay.sessionId ?? '', round_number: essay.roundNumber,
      input_text: input, grading_result: typeof object?.result === 'string' ? object.result : '',
      overall_score: typeof object?.overall_score === 'number' ? f32Json(object.overall_score) : essay.score == null ? null : f32Json(essay.score),
      dimension_scores_json: essay.dimensionScores == null ? null : storedDimensionScoresJson(essay.dimensionScores), created_at: essay.createdAt,
    };
  };
  return {
    stream: (request, emit, signal) => runGrading(request, runtime, emit, signal),
    async createSession(title, essayType, gradeLevel, customPrompt) {
      return vfsOperation('创建作文会话失败', () => repo.createSession(runtime.connection(), { title, essayType, gradeLevel, customPrompt }));
    },
    async getSession(id) {
      sessionId(id);
      return vfsOperation(`获取作文会话失败 (session_id=${id})`, () => repo.getSession(runtime.connection(), id));
    },
    async updateSession(value) {
      sessionId(value.id);
      vfsOperation(`更新作文会话失败 (session_id=${value.id})`, () => repo.updateSession(runtime.connection(), value.id,
        value.title ?? null, value.is_favorite ?? null, value.essay_type ?? null, value.grade_level ?? null, value.custom_prompt ?? null));
    },
    async deleteSession(id) {
      sessionId(id);
      return vfsOperation(`删除作文会话失败 (session_id=${id})`, () => repo.purgeSession(runtime.connection(), id));
    },
    async listSessions(offset, limit, query) {
      const take = Math.min(limit ?? 20, 500), skip = offset ?? 0;
      const needle = query?.trim().toLowerCase();
      if (!needle) return vfsOperation('获取作文会话列表失败', () => repo.listSessions(runtime.connection(), take, skip));
      return vfsOperation(`搜索作文会话失败 (query=${needle})`, () => repo.listSessions(runtime.connection(), 0xffff_ffff, 0))
        .filter(value => [value.title, value.essay_type, value.grade_level].some(field => field.toLowerCase().includes(needle)))
        .slice(skip, skip + take);
    },
    async toggleFavorite(id) {
      sessionId(id);
      return vfsOperation(`切换收藏状态失败 (session_id=${id})`, () => repo.toggleSessionFavorite(runtime.connection(), id));
    },
    async getRounds(id) {
      sessionId(id);
      return vfsOperation(`获取批改轮次失败 (session_id=${id})`, () => repo.getRoundsBySession(runtime.connection(), id)).map(round);
    },
    async getRound(id, number) {
      sessionId(id);
      if (number < 1) throw new CommandError(AppError.validation(`round_number 必须 >= 1 (收到 ${number})`));
      const value = vfsOperation(`获取批改轮次失败 (session_id=${id}, round=${number})`, () => repo.getRound(runtime.connection(), id, number));
      return value === null ? null : round(value);
    },
    async getLatestRoundNumber(id) {
      sessionId(id);
      return vfsOperation(`获取最新轮次号失败 (session_id=${id})`, () => repo.getLatestRoundNumber(runtime.connection(), id));
    },
    async getModes() {
      const builtin = getBuiltinGradingModes(), custom = await modes.listModes();
      return [...builtin.map(mode => ({ ...(custom.find(value => value.id === mode.id) ?? mode), isBuiltin: true })),
        ...custom.filter(mode => !builtin.some(value => value.id === mode.id))].map(modeToWire);
    },
    async getMode(id) {
      const canonical = canonicalModeId(id), builtin = getBuiltinGradingModes().find(mode => mode.id === canonical);
      const mode = await modes.getMode(canonical) ?? builtin;
      return mode === undefined ? null : modeToWire({ ...mode, isBuiltin: builtin !== undefined || mode.isBuiltin });
    },
    async createCustomMode(input) {
      return modeOperation('创建自定义批阅模式失败', async () => modeToWire(await modes.createMode({ name: input.name, description: input.description,
        systemPrompt: input.system_prompt, scoreDimensions: dimensions(input.score_dimensions), totalMaxScore: input.total_max_score })));
    },
    async updateCustomMode(input) {
      return modeOperation(`更新自定义批阅模式失败 (mode_id=${input.id})`, async () => modeToWire(await modes.updateMode({ id: input.id,
        ...(input.name == null ? {} : { name: input.name }), ...(input.description == null ? {} : { description: input.description }),
        ...(input.system_prompt == null ? {} : { systemPrompt: input.system_prompt }),
        ...(input.score_dimensions == null ? {} : { scoreDimensions: dimensions(input.score_dimensions) }),
        ...(input.total_max_score == null ? {} : { totalMaxScore: input.total_max_score }),
      })));
    },
    async deleteCustomMode(id) { return modeOperation(`删除自定义批阅模式失败 (mode_id=${id})`, () => modes.deleteMode(id)); },
    async listCustomModes() { return (await modes.listModes()).map(modeToWire); },
    async saveBuiltinOverride(input) {
      return modeOperation(`保存预置模式覆盖失败 (builtin_id=${input.builtin_id})`, async () => modeToWire({ ...await modes.saveBuiltinOverride({
        builtinId: input.builtin_id, name: input.name, description: input.description, systemPrompt: input.system_prompt,
        scoreDimensions: dimensions(input.score_dimensions), totalMaxScore: input.total_max_score,
      }), isBuiltin: true }));
    },
    async resetBuiltinMode(id) {
      await modeOperation(`重置预置模式失败 (builtin_id=${id})`, () => modes.resetBuiltinMode(id));
      const mode = getBuiltinGradingModes().find(value => value.id === canonicalModeId(id));
      if (!mode) throw new CommandError(AppError.not_found(`预置模式不存在: ${id}`));
      return modeToWire(mode);
    },
    async hasBuiltinOverride(id) { return modes.hasBuiltinOverride(id); },
    async getModels() {
      const configs = await runtime.llm.getApiConfigs(), assignments = await runtime.llm.getModelAssignments();
      return configs.filter(config => config.enabled && !config.isEmbedding && !config.isReranker)
        .map(config => ({ id: config.id, name: config.name, model: config.model, is_default: config.id === assignments.model2_config_id }));
    },
  };
}

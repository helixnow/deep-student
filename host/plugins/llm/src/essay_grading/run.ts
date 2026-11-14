/** Rust run_grading/run_grading_inner: exclusive stream, dual-channel errors, save then complete. */
import type * as Wire from '../../../../../contracts/ipc/generated/L15-review-analytics.ts';
import { AppError, CommandError, type JsonValue } from '../../../../platform/errors/api.ts';
import type { SqlExecutor } from '../../../../platform/storage/api.ts';
import type { EssayRepository } from '../../../vfs-repos/api.ts';
import type { LLMManager } from '../../api.ts';
import { logError, logInfo, logWarn } from '../logging.ts';
import { toRfc3339 } from '../../../../platform/time/index.ts';
import { gradingRequestFromWire, type GradingMode } from './types.ts';
import { buildGradingPrompts, gradingStageCode, parseScoreFromResult, resolveGradingMode,
  StageTracker, StreamSessionGuard, validateImagePayloads } from './pipeline.ts';
import type { EssayStreamTransport } from './transport.ts';
import { errorText, gradingError } from './errors.ts';
import { parsedScoreJson } from './score_json.ts';
import { f32Wire } from './f32.ts';

export interface GradingRuntime {
  llm: LLMManager;
  repository: EssayRepository;
  connection(): SqlExecutor;
  customModes(): Promise<GradingMode[]>;
  transport: EssayStreamTransport;
}

export async function runGrading(
  wire: Wire.GradingRequest, runtime: GradingRuntime,
  emit: (event: string, payload: unknown) => void, signal: AbortSignal,
): Promise<Wire.GradingResponse | null> {
  if (wire.session_id.trim() === '') throw new CommandError(AppError.validation('session_id 不能为空'));
  const request = gradingRequestFromWire(wire);
  const channel = `essay_grading_stream_${request.streamSessionId}`;
  const send = (payload: Record<string, unknown>): void => {
    try { emit(channel, payload); }
    catch (error) { logError(`[EssayGrading] 发送${payload.type}事件失败: ${errorText(error)}`); }
  };
  if (request.streamSessionId.trim() === '') {
    const error = AppError.validation('stream_session_id 不能为空');
    send({ type: 'error', message: error.message });
    throw new CommandError(error);
  }
  const guard = StreamSessionGuard.acquire(request.streamSessionId);
  if (guard === null) throw new CommandError(AppError.with_details('Validation',
    `该批改流会话已在进行中: ${request.streamSessionId}`, {
      code: 'ESSAY_STREAM_ALREADY_ACTIVE', stream_session_id: request.streamSessionId, retryable: false,
    }));
  let count = 0;
  try {
    const mode = resolveGradingMode(request.modeId, await runtime.customModes());
    const essayImages = (request.imageBase64List ?? []).filter(value => value.trim() !== '');
    const topicImages = (request.topicImageBase64List ?? []).filter(value => value.trim() !== '');
    const [systemPrompt, userPrompt] = buildGradingPrompts(request, mode, essayImages.length > 0);
    const { llm } = runtime;
    let config;
    if (request.modelConfigId !== null) {
      config = (await llm.getApiConfigs()).find(value => value.id === request.modelConfigId);
      if (!config) throw AppError.llm(`未找到模型配置: ${request.modelConfigId}`);
      if (!config.enabled) throw AppError.llm(`模型配置已禁用: ${request.modelConfigId}`);
      if (config.isEmbedding) throw AppError.llm(`嵌入模型不支持作文批改: ${request.modelConfigId}`);
    } else config = await llm.getModel2Config();
    const apiKey = await llm.decryptApiKey(config.apiKey);
    validateImagePayloads(essayImages, topicImages);
    send({ type: 'progress', stage: 'preparing', char_count: 0 });
    const stages = new StageTracker();
    let accumulated = '';
    const status = await runtime.transport({ config, apiKey, systemPrompt, userPrompt,
      streamEvent: channel, essayImages, topicImages, signal }, chunk => {
      accumulated += chunk;
      count += Array.from(chunk).length;
      for (const stage of stages.advance(chunk)) send({ type: 'progress', stage: gradingStageCode(stage), char_count: count });
      send({ type: 'data', chunk, char_count: count });
    });
    if (status === 'cancelled') { send({ type: 'cancelled' }); return null; }
    if (status === 'incomplete') {
      if (accumulated.includes('</score>')) logWarn(`[EssayGrading] 流未收到 DONE 标记，但评分标签已完整（${count} 字符），按完成处理`);
      else {
        logWarn(`[EssayGrading] 流式响应未完成，丢弃不完整结果（已累积 ${count} 字符）`);
        throw AppError.with_details('LLM', `批改流式响应异常中断，结果不完整（已生成 ${count} 字符）。请检查网络连接后重试。`,
          { code: 'ESSAY_STREAM_INCOMPLETE', category: 'network', retryable: true });
      }
    }
    if (signal.aborted || await llm.consumePendingCancel(channel)) {
      logInfo('[EssayGrading] 流完成后发现已取消，丢弃结果');
      send({ type: 'cancelled' }); return null;
    }
    send({ type: 'progress', stage: 'saving', char_count: count });
    const parsed = parseScoreFromResult(accumulated, mode);
    const parsedWire: JsonValue = parsed === null ? null : {
      total: parsed.total, max_total: parsed.maxTotal, grade: parsed.grade,
      dimensions: parsed.dimensions.map(dim => ({ name: dim.name, score: dim.score, max_score: dim.maxScore, comment: dim.comment })),
    };
    const parsedJson = parsedWire === null ? null : parsedScoreJson(parsedWire);
    const overall = parsed?.total ?? null;
    const createdAt = toRfc3339();
    const repo = runtime.repository;
    const conn = runtime.connection();
    let session;
    try { session = repo.getSession(conn, request.sessionId); }
    catch (error) { throw AppError.database(`获取会话失败: ${errorText(error)}`); }
    if (session === null) throw AppError.not_found(`会话不存在: ${request.sessionId}`);
    let essay;
    try {
      essay = repo.createEssay(conn, {
        title: request.roundNumber > 1 ? `${session.title} (第${request.roundNumber}轮)` : session.title,
        essayType: session.essay_type, gradeLevel: session.grade_level,
        content: request.inputText, sessionId: request.sessionId, roundNumber: request.roundNumber,
        customPrompt: request.customPrompt?.trim() || session.custom_prompt,
        gradingResult: { result: accumulated, overall_score: overall, dimension_scores: parsedJson },
        score: overall === null ? null : Math.round(overall), dimensionScores: parsedWire,
      });
    } catch (error) { throw AppError.database(`VFS 保存失败: ${errorText(error)}`); }
    logInfo(`[EssayGrading] VFS 保存成功: essay_id=${essay.id}`);
    send({ type: 'complete', round_id: essay.id, grading_result: accumulated,
      overall_score: overall === null ? null : f32Wire(overall), parsed_score: parsedJson, created_at: createdAt });
    return { round_id: essay.id, session_id: request.sessionId, round_number: request.roundNumber,
      grading_result: accumulated, overall_score: overall, dimension_scores_json: parsedJson, created_at: createdAt };
  } catch (cause) {
    const error = gradingError(cause);
    const payload: Record<string, unknown> = { type: 'error', message: error.message };
    if (count > 0) payload.partial_chars = count;
    if (error.details !== null && typeof error.details === 'object' && !Array.isArray(error.details)) {
      for (const [key, value] of Object.entries(error.details)) {
        if (!['type', 'message', 'partial_chars'].includes(key)) payload[key] = value;
      }
    }
    send(payload);
    throw new CommandError(error);
  } finally { guard.release(); }
}

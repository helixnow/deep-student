import { AppError } from '../../../platform/errors/api.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';
import type { ApiConfig, FailoverPolicy, ParamOverrides } from '../api.ts';
import { AUTH_MODE_NONE, AUTH_MODE_OPENAI_CODEX_OAUTH } from './protocol.ts';
import { logWarn } from './logging.ts';
import { encodeUtf8 } from '../../../platform/util/portable.ts';

export const LLM_ERROR_CODE_KEY = 'llm_error_code';
export const LLM_ERROR_CODE_EMPTY_RESPONSE = 'EMPTY_RESPONSE';
export const LLM_ERROR_CODE_CONTEXT_WINDOW_EXCEEDED = 'CONTEXT_WINDOW_EXCEEDED';
export const LLM_ERROR_CODE_COMPACTION_REQUIRED = 'COMPACTION_REQUIRED';
export type LlmErrorClass = 'Cancelled' | 'NonRetryable' | 'RetryableTransient' | 'RateLimited' | 'AuthFailed';
export type FailoverScenario = 'ChatMain' | 'BackgroundTask';

export function modelFallbackAllowed(policy: FailoverPolicy, scenario: FailoverScenario): boolean {
  return policy.enabled && (scenario === 'BackgroundTask' || policy.autoDegradeChat);
}
export function resolveFallbackChain(policy: FailoverPolicy, task: string, primaryId: string): string[] {
  const chain = policy.taskFallbacks[task]?.length ? policy.taskFallbacks[task]! : policy.defaultFallbacks;
  const result: string[] = [];
  for (const candidate of chain) {
    const id = candidate.trim();
    if (id && id !== primaryId && !result.includes(id)) result.push(id);
  }
  return result;
}
export function resolvePurposeModelId(policy: FailoverPolicy, task: string): string | null { return policy.purposeModels[task]?.trim() || null; }
export function isKnownUtilityPurpose(task: string): boolean { return ['compaction', 'memory_flush', 'utility', 'memory_decision'].includes(task); }
function object(value: JsonValue): Record<string, JsonValue> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
export function tagEstablishFailure(error: AppError, httpStatus: number | null): AppError {
  const details = error.details === null ? {} : structuredClone(error.details);
  const obj = object(details);
  if (obj) obj.llm_failover = { phase: 'establish', http_status: httpStatus };
  return { ...error, details };
}
export function attachLlmErrorCode(error: AppError, code: string): AppError {
  const details = error.details === null ? {} : structuredClone(error.details);
  const obj = object(details);
  if (obj) obj[LLM_ERROR_CODE_KEY] = code;
  return { ...error, details };
}
export function llmErrorCode(error: AppError): string | null {
  const code = object(error.details)?.[LLM_ERROR_CODE_KEY];
  return typeof code === 'string' ? code : null;
}
export function providerBodyIndicatesContextWindow(body: string): boolean {
  const lower = body.replace(/[A-Z]/g, c => c.toLowerCase());
  return ['context length', 'context_length', 'maximum context', 'max context', 'too many tokens',
    'exceeds the maximum', 'exceed the maximum', 'prompt is too long', 'input is too long',
    'reduce the length', 'maximum number of tokens', 'context window', '上下文长度', '超出最大']
    .some(needle => lower.includes(needle));
}
export function classifyLlmError(error: AppError): LlmErrorClass {
  const lower = error.message.toLowerCase();
  if (error.message.includes('取消') || lower.includes('cancel')) return 'Cancelled';
  const code = llmErrorCode(error);
  if (code === LLM_ERROR_CODE_EMPTY_RESPONSE) return 'RetryableTransient';
  if (code === LLM_ERROR_CODE_CONTEXT_WINDOW_EXCEEDED || code === LLM_ERROR_CODE_COMPACTION_REQUIRED) return 'NonRetryable';
  const tag = object(object(error.details)?.llm_failover ?? null);
  if (tag?.phase !== 'establish') return 'NonRetryable';
  const status = tag.http_status;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 0 || status >= 2 ** 64) return 'RetryableTransient';
  if (status === 429) return 'RateLimited';
  if (status === 401) return 'AuthFailed';
  if (status === 403) return ['invalid api key', 'invalid_api_key', 'invalid credential', 'invalid signature', 'authentication failed'].some(x => lower.includes(x)) ? 'AuthFailed' : 'NonRetryable';
  if (status === 408 || (status >= 500 && status <= 599)) return 'RetryableTransient';
  return 'NonRetryable';
}

export class CooldownTable {
  readonly _entries = new Map<string, number>();
  setFor(key: string, durationMs: number): void { this.setUntil(key, performance.now() + durationMs); }
  setUntil(key: string, until: number): void { this._entries.set(key, until); }
  isCoolingAt(key: string, now: number): boolean {
    for (const [k, until] of this._entries) if (until <= now) this._entries.delete(k);
    return this._entries.has(key);
  }
  isCooling(key: string): boolean { return this.isCoolingAt(key, performance.now()); }
}

/** Rust DefaultHasher = SipHash-1-3, zero keys; str::hash appends 0xff. */
export function keyFingerprint(vendorId: string, apiKey: string): string {
  const vendor = encodeUtf8(vendorId), key = encodeUtf8(apiKey);
  const data = new Uint8Array(vendor.length + key.length + 2);
  data.set(vendor, 0); data[vendor.length] = 255; data.set(key, vendor.length + 1); data[data.length - 1] = 255;
  const view = new DataView(data.buffer);
  const mask = 0xffffffffffffffffn;
  const rol = (x: bigint, n: bigint) => ((x << n) | (x >> (64n - n))) & mask;
  let v0 = 0x736f6d6570736575n, v1 = 0x646f72616e646f6dn, v2 = 0x6c7967656e657261n, v3 = 0x7465646279746573n;
  const round = () => {
    v0 = (v0 + v1) & mask; v1 = rol(v1, 13n); v1 ^= v0; v0 = rol(v0, 32n);
    v2 = (v2 + v3) & mask; v3 = rol(v3, 16n); v3 ^= v2;
    v0 = (v0 + v3) & mask; v3 = rol(v3, 21n); v3 ^= v0;
    v2 = (v2 + v1) & mask; v1 = rol(v1, 17n); v1 ^= v2; v2 = rol(v2, 32n);
  };
  let offset = 0;
  for (; offset + 8 <= data.length; offset += 8) {
    const block = view.getBigUint64(offset, true); v3 ^= block; round(); v0 ^= block;
  }
  let last = BigInt(data.length & 255) << 56n;
  for (let i = 0; offset + i < data.length; i++) last |= BigInt(data[offset + i]!) << BigInt(i * 8);
  v3 ^= last; round(); v0 ^= last; v2 ^= 255n; round(); round(); round();
  return `${vendorId}:${(v0 ^ v1 ^ v2 ^ v3).toString(16).padStart(16, '0')}`;
}

export interface ModelKeySet { configId: string; vendorId: string; keys: string[]; allowsEmptyKey: boolean }
export interface PlannedAttempt { modelIdx: number; keyIdx: number; cooldownKey: string }
export function buildAttemptPlan(models: ModelKeySet[], cooldowns: CooldownTable, now: number): PlannedAttempt[] {
  const plan: PlannedAttempt[] = [];
  let fallback: PlannedAttempt | null = null;
  models.forEach((model, modelIdx) => model.keys.forEach((key, keyIdx) => {
    if (!key.trim() && !model.allowsEmptyKey) return;
    const attempt = { modelIdx, keyIdx, cooldownKey: keyFingerprint(model.vendorId, key) };
    if (cooldowns.isCoolingAt(attempt.cooldownKey, now)) { fallback ??= attempt; return; }
    plan.push(attempt);
  }));
  if (!plan.length && fallback) plan.push(fallback);
  return plan;
}
export function failoverToNextAllowed(cls: LlmErrorClass, current: PlannedAttempt, next: PlannedAttempt): boolean {
  if (cls === 'Cancelled' || cls === 'NonRetryable') return false;
  return cls !== 'AuthFailed' || next.modelIdx === current.modelIdx;
}
export function resolveEnabledTextModel<T extends Pick<ApiConfig, 'id' | 'enabled' | 'isEmbedding' | 'isReranker'> & Partial<Pick<ApiConfig, 'model'>>>(configs: T[], candidateIds: Iterable<string>): T | null {
  for (const id of candidateIds) {
    const found = configs.find(c => c.id === id && c.enabled && !c.isEmbedding && !c.isReranker
      && c.model !== 'deepseek-asr' && c.model !== 'deepseek-ocr');
    if (found) return found;
  }
  return null;
}
export function supportsRequiredModality(config: Pick<ApiConfig, 'isMultimodal'>, required: boolean | null): boolean { return !required || config.isMultimodal; }
export function applyParamOverrides(config: ApiConfig, params: ParamOverrides): void {
  if (params.temperature != null) config.temperature = Math.fround(params.temperature);
  if (params.maxOutputTokens != null) config.maxOutputTokens = params.maxOutputTokens;
  if (params.topP != null) config.topPOverride = Math.fround(params.topP);
  if (params.frequencyPenalty != null) config.frequencyPenaltyOverride = Math.fround(params.frequencyPenalty);
  if (params.presencePenalty != null) config.presencePenaltyOverride = Math.fround(params.presencePenalty);
}

// ============================================================
// Failover 驱动（routing.rs:492–773）
// ============================================================

export const FAILOVER_POLICY_SETTING_KEY = 'llm_failover_policy';
export const FAILOVER_EVENT_NAME = 'llm-failover';
/** 无 fallback 候选时，建立阶段的最大内部重试次数。 */
export const ESTABLISH_RETRIES_WITHOUT_FALLBACK = 5;
/** 有 fallback 候选时只做一次短退避重试。 */
export const ESTABLISH_RETRIES_WITH_FALLBACK = 1;

/** 一次带 failover 的调用运行参数。 */
export interface FailoverRun {
  task: string;
  scenario: FailoverScenario;
  userPinned: boolean;
  attemptsHandle429Internally: boolean;
  /** `true` ⇒ 请求含多模态输入；`false`/`null` ⇒ 纯文本（多模态模型同样可接收）。 */
  requiredIsMultimodal: boolean | null;
  paramOverrides?: ParamOverrides;
}

/** Failover 驱动依赖的运行时（策略/配置存储、key 候选、冷却表、事件 sink）。 */
export interface FailoverRuntime {
  getFailoverPolicy(): Promise<FailoverPolicy>;
  getApiConfigs(): Promise<ApiConfig[]>;
  candidateApiKeysFor(config: ApiConfig): Promise<string[]>;
  cooldowns?: CooldownTable;
  emit?(channel: string, payload: JsonValue): void;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

const KEY_COOLDOWNS = new CooldownTable();

/** 全局冷却表（进程内存态，重启即清空）。 */
export function keyCooldowns(): CooldownTable {
  return KEY_COOLDOWNS;
}

function defaultPolicy(): FailoverPolicy {
  return {
    enabled: true, autoDegradeChat: false, defaultFallbacks: [], taskFallbacks: {},
    purposeModels: {}, keyCooldownSecs: 60, rateLimitBackoffMs: 1500,
  };
}

function shortReason(error: AppError, cls: LlmErrorClass): string {
  return `${cls}: ${Array.from(error.message).slice(0, 200).join('')}`;
}

function isAuthMode(config: ApiConfig, mode: string): boolean {
  return config.authMode !== null && config.authMode !== undefined
    && config.authMode.toLowerCase() === mode;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * 带 failover 的统一调用驱动（routing.rs:581 `run_with_failover`）：
 * 1. 主模型未冷却 key → 同 provider 内 key 轮换 → fallback 链模型；
 * 2. 只有被打标为「建立阶段」的可重试错误才推进候选；
 * 3. 429 先做同候选短退避重试一次（若 attempt 内部不自带）；
 * 4. 发生切换时向前端 emit `llm-failover` 事件。
 */
export async function runWithFailover<T>(
  runtime: FailoverRuntime,
  run: FailoverRun,
  primary: ApiConfig,
  attempt: (config: ApiConfig, establishRetries: number) => Promise<T>,
): Promise<T> {
  let policy: FailoverPolicy;
  try {
    policy = await runtime.getFailoverPolicy();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    policy = defaultPolicy();
  }

  if (resolveEnabledTextModel([primary], [primary.id]) === null) {
    throw AppError.configuration(`模型配置 ${primary.id} 已禁用或不支持文本调用`);
  }
  if (!supportsRequiredModality(primary, run.requiredIsMultimodal)) {
    throw AppError.configuration(
      `模型配置 ${primary.id} 不满足已编译请求的 ${run.requiredIsMultimodal === null ? 'None' : `Some(${run.requiredIsMultimodal})`} 能力要求`,
    );
  }

  const overrides = run.paramOverrides ?? {};
  const applyOverrides = (config: ApiConfig): ApiConfig => {
    const copy = structuredClone(config);
    applyParamOverrides(copy, overrides);
    return copy;
  };

  // OAuth 是单一受管传输，不参与 API-key 轮换或模型 fallback。
  if (isAuthMode(primary, AUTH_MODE_OPENAI_CODEX_OAUTH)) {
    return attempt(applyOverrides(primary), ESTABLISH_RETRIES_WITHOUT_FALLBACK);
  }

  // 总开关关闭时完全绕过 key 轮换、冷却与模型 fallback，保持单模型旧行为。
  if (!policy.enabled) {
    return attempt(applyOverrides(primary), ESTABLISH_RETRIES_WITHOUT_FALLBACK);
  }

  // 1. 候选模型集：主模型 +（允许时的）fallback 链
  const models: ApiConfig[] = [structuredClone(primary)];
  if (modelFallbackAllowed(policy, run.scenario)) {
    const chain = resolveFallbackChain(policy, run.task, models[0]!.id);
    if (chain.length > 0) {
      let all: ApiConfig[] = [];
      try {
        all = await runtime.getApiConfigs();
      } catch (error) {
        if (!(error instanceof Error)) throw error;
      }
      for (const target of chain) {
        if (models.some((model) => model.id === target)) continue;
        const found = resolveEnabledTextModel(all, [target]);
        if (found === null) continue;
        if (supportsRequiredModality(found, run.requiredIsMultimodal)) models.push(structuredClone(found));
      }
    }
  }

  // 2. 每个候选模型的 key 集合（主 key + 供应商额外 key）
  const keySets: string[][] = [];
  for (const model of models) keySets.push(await runtime.candidateApiKeysFor(model));

  // 3. 扁平化尝试计划（过滤冷却 key；全体冷却时确定性保底一个候选）
  const metas: ModelKeySet[] = models.map((model, index) => ({
    configId: model.id,
    vendorId: model.vendorId ?? '',
    keys: keySets[index] ?? [],
    allowsEmptyKey: isAuthMode(model, AUTH_MODE_NONE),
  }));
  const cooldowns = runtime.cooldowns ?? keyCooldowns();
  const now = runtime.now ?? (() => performance.now());
  const plan = buildAttemptPlan(metas, cooldowns, now());
  if (plan.length === 0) throw AppError.configuration('没有可用的模型候选（Failover 计划为空）');

  const establishRetries = plan.length > 1
    ? ESTABLISH_RETRIES_WITH_FALLBACK
    : ESTABLISH_RETRIES_WITHOUT_FALLBACK;
  const emit = (kind: string, previous: ApiConfig, next: ApiConfig, reason: string, attemptNumber: number): void => {
    runtime.emit?.(FAILOVER_EVENT_NAME, {
      task: run.task,
      kind,
      from_config_id: previous.id,
      from_model: previous.model,
      to_config_id: next.id,
      to_model: next.model,
      reason,
      attempt: attemptNumber,
      total: plan.length,
      user_pinned: run.userPinned,
      // 临时 override：每次新请求重新评估主模型与 key 的冷却状态
      temporary: true,
    });
  };

  let index = 0;
  let retried429OnCurrent = false;
  let pendingSwitch: { modelIdx: number; reason: string } | null = null;

  for (;;) {
    const planned = plan[index]!;
    const model = models[planned.modelIdx]!;
    const config = applyOverrides(model);
    config.apiKey = keySets[planned.modelIdx]?.[planned.keyIdx] ?? '';

    // 切换通知：自动 fallback 是临时状态，不持久化
    if (pendingSwitch !== null) {
      const switchKind = pendingSwitch.modelIdx === planned.modelIdx ? 'key_rotation' : 'model_fallback';
      logWarn(`[Failover] ${switchKind}（task=${run.task}）: ${models[pendingSwitch.modelIdx]!.model} -> ${config.model}，原因: ${pendingSwitch.reason}`);
      emit(switchKind, models[pendingSwitch.modelIdx]!, config, pendingSwitch.reason, index + 1);
      pendingSwitch = null;
    }

    let error: AppError;
    try {
      return await attempt(config, establishRetries);
    } catch (caught) {
      if (typeof caught !== 'object' || caught === null || !('error_type' in caught) || !('message' in caught)) {
        throw caught;
      }
      error = caught as AppError;
    }

    const cls = classifyLlmError(error);
    if (cls === 'Cancelled') throw error;
    // 429/401 的 key 进入冷却
    if (cls === 'RateLimited' || cls === 'AuthFailed') {
      cooldowns.setFor(planned.cooldownKey, policy.keyCooldownSecs * 1_000);
    }
    // 429：同候选先做一次短退避重试（attempt 内部已自带退避的出口跳过）
    if (cls === 'RateLimited' && !run.attemptsHandle429Internally && !retried429OnCurrent) {
      retried429OnCurrent = true;
      await (runtime.sleep ?? defaultSleep)(policy.rateLimitBackoffMs);
      continue;
    }
    const next = plan[index + 1];
    if (next === undefined || !failoverToNextAllowed(cls, planned, next)) throw error;
    pendingSwitch = { modelIdx: planned.modelIdx, reason: shortReason(error, cls) };
    index += 1;
    retried429OnCurrent = false;
  }
}

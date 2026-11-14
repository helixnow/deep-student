import type {
  ChatAnkiToolExecutor, FsrsSchedulerConfigUpdate, SchedulerService, ToolCall,
  ToolConcurrency, ToolExecutionContext, ToolResultInfo, ToolSensitivity,
} from '../api.ts';
import { isJsonNumberAtom } from '../../../kernel/serde.ts';
import { errorText, stripToolNamespace, toolResult } from './execution.ts';

export interface SchedulerConfigUpdateRequest {
  new_per_day: number | null;
  reviews_per_day: number | null;
  desired_retention: number | null;
  leech_threshold: number | null;
  leech_action: string | null;
  enable_fuzz: boolean | null;
}

export function fsrsSettingsError(code: string, message: string, hint: string): string {
  const en = `Flashcard scheduler settings operation failed (${code}).`;
  return JSON.stringify({
    code, hint,
    hintFallback: {
      'zh-CN': hint,
      'en-US': 'Review the structured error code and correct the request before retrying.',
    },
    retryable: false,
    messageKey: 'chat.tools.fsrs_settings.error', messageParams: { code, detail: message },
    messageFallback: { 'zh-CN': message, 'en-US': en }, message: `${message} / ${en}`,
  });
}

function invalid(message: string): never {
  throw new Error(fsrsSettingsError('INVALID_ARGS', message, '修正参数后重试'));
}

/** arbitrary_precision `Number::as_u64`: `self.n.parse()`; the literal `-0` is stored as i64 0. */
function asU64(value: unknown): number | null {
  if (isJsonNumberAtom(value)) {
    const text = value.rawJSON;
    if (!/^(?:-?0|[1-9][0-9]*)$/.test(text)) return null;
    const exact = BigInt(text);
    return exact < 2n ** 64n ? Number(exact) : null;
  }
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 2 ** 64 ? value : null;
}

/** arbitrary_precision `Number::as_f64`: the literal parsed as f64, finite only. */
function asF64(value: unknown): number | null {
  const number = isJsonNumberAtom(value) ? Number(value.rawJSON) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
}

function parseLimit(value: unknown, name: string): number {
  const n = asU64(value);
  if (n === null) invalid(`${name} 必须是 0–9999 的整数`);
  if (n > 9999) invalid(`${name} 必须是 0–9999 的整数（对齐闪卡设置面板的 0–9999 区间）`);
  return n;
}

/** fsrs_settings_executor.rs:232–285, including validation order and alias precedence. */
export function parseUpdateRequest(arguments_: unknown): SchedulerConfigUpdateRequest {
  if (arguments_ === null || typeof arguments_ !== 'object' || Array.isArray(arguments_)) {
    invalid('参数必须是 JSON 对象');
  }
  const args = arguments_ as Record<string, unknown>;
  const field = (snake: string, camel: string) => args[snake] ?? args[camel];
  const request: SchedulerConfigUpdateRequest = {
    new_per_day: null, reviews_per_day: null, desired_retention: null,
    leech_threshold: null, leech_action: null, enable_fuzz: null,
  };
  let value = field('new_per_day', 'newPerDay');
  if (value != null) request.new_per_day = parseLimit(value, 'new_per_day');
  value = field('reviews_per_day', 'reviewsPerDay');
  if (value != null) request.reviews_per_day = parseLimit(value, 'reviews_per_day');
  value = field('desired_retention', 'desiredRetention');
  if (value != null) {
    const n = asF64(value);
    if (n === null) invalid('desired_retention 必须是 (0,1) 开区间内的小数，例如 0.9');
    if (n <= 0 || n >= 1) invalid('desired_retention 必须在 (0,1) 开区间内，例如 0.9');
    request.desired_retention = n;
  }
  value = field('leech_threshold', 'leechThreshold');
  if (value != null) {
    const n = asU64(value);
    if (n === null || n > 9999) invalid('leech_threshold 必须是 0–9999 的整数');
    request.leech_threshold = n;
  }
  value = field('leech_action', 'leechAction');
  if (value != null) {
    if (value !== 'suspend' && value !== 'mark') invalid('leech_action 仅支持 "suspend"（暂停）或 "mark"（仅标记）');
    request.leech_action = value;
  }
  value = field('enable_fuzz', 'enableFuzz');
  if (value != null) {
    if (typeof value !== 'boolean') invalid('enable_fuzz 必须是布尔值');
    request.enable_fuzz = value;
  }
  if (Object.values(request).every((value) => value === null)) {
    invalid('至少提供一个要修改的字段：new_per_day / reviews_per_day / desired_retention / leech_threshold / leech_action / enable_fuzz');
  }
  return request;
}

function requireService(ctx: ToolExecutionContext): SchedulerService {
  if (!ctx.scheduler) {
    throw new Error(fsrsSettingsError('FSRS_DB_UNAVAILABLE', '闪卡数据库尚未初始化，调度设置不可用', '重启应用后重试；若仍失败请检查闪卡数据目录'));
  }
  return ctx.scheduler;
}

export class FsrsSettingsExecutor implements ChatAnkiToolExecutor {
  canHandle(name: string): boolean {
    return ['fsrs_get_scheduler_config', 'fsrs_update_scheduler_config'].includes(stripToolNamespace(name));
  }
  sensitivityLevel(name: string): ToolSensitivity {
    return stripToolNamespace(name) === 'fsrs_update_scheduler_config' ? 'medium' : 'low';
  }
  concurrencyClass(name: string): ToolConcurrency {
    return stripToolNamespace(name) === 'fsrs_update_scheduler_config' ? 'serial' : 'read_only';
  }
  name(): string { return 'FsrsSettingsExecutor'; }

  getConfig(ctx: ToolExecutionContext): unknown {
    const service = requireService(ctx);
    let config;
    try { config = service.getSchedulerConfig(); }
    catch (error) {
      throw new Error(fsrsSettingsError('FSRS_CONFIG_UNAVAILABLE', `读取闪卡调度配置失败: ${errorText(error)}`, '稍后重试；若持续失败请查看后端日志'));
    }
    const getStatistics = service.getReviewStatistics;
    if (typeof getStatistics !== 'function') {
      // Rust 的 FsrsReviewService 与本方法同源；L15 尚未发布该面时，
      // 读取配置仍可用，但 dailyLimits 无法伪造，按 Rust 的错误分类 fail-closed。
      throw new Error(fsrsSettingsError(
        'FSRS_STATS_UNAVAILABLE',
        '读取闪卡今日额度统计失败: review 服务未发布 getReviewStatistics(days)',
        '稍后重试；若持续失败请查看后端日志',
      ));
    }
    let statistics;
    try { statistics = getStatistics.call(service, 7); }
    catch (error) {
      throw new Error(fsrsSettingsError('FSRS_STATS_UNAVAILABLE', `读取闪卡今日额度统计失败: ${errorText(error)}`, '稍后重试；若持续失败请查看后端日志'));
    }
    return { config, dailyLimits: statistics.dailyLimits };
  }

  updateConfig(args: unknown, ctx: ToolExecutionContext): unknown {
    const request = parseUpdateRequest(args);
    const service = requireService(ctx);
    // Rust 侧 `Option::None` 在 serde 缺省下等价于“未提供”；L15 的校验会拒绝
    // 显式 null，因此只把用户真正给出的字段放进 update。
    const update: FsrsSchedulerConfigUpdate = {
      ...(request.new_per_day === null ? {} : { newPerDay: request.new_per_day }),
      ...(request.reviews_per_day === null ? {} : { reviewsPerDay: request.reviews_per_day }),
      ...(request.desired_retention === null ? {} : { desiredRetention: request.desired_retention }),
      ...(request.leech_threshold === null ? {} : { leechThreshold: request.leech_threshold }),
      ...(request.leech_action === null ? {} : { leechAction: request.leech_action }),
      ...(request.enable_fuzz === null ? {} : { enableFuzz: request.enable_fuzz }),
    };
    let config;
    try { config = service.updateSchedulerConfig(update); }
    catch (error) {
      throw new Error(fsrsSettingsError('FSRS_UPDATE_FAILED', `写入闪卡调度设置失败: ${errorText(error)}`, '稍后重试；若持续失败请查看后端日志'));
    }
    return { config, updated: Object.keys(request).filter((key) => request[key as keyof typeof request] !== null) };
  }

  async execute(call: ToolCall, ctx: ToolExecutionContext): Promise<ToolResultInfo> {
    const started = performance.now();
    ctx.emitToolCallStart(call.name, call.arguments, call.id);
    let output: unknown = null;
    let error: string | undefined;
    try {
      switch (stripToolNamespace(call.name)) {
        case 'fsrs_get_scheduler_config': output = this.getConfig(ctx); break;
        case 'fsrs_update_scheduler_config': output = this.updateConfig(call.arguments, ctx); break;
        default: throw new Error(fsrsSettingsError('UNKNOWN_TOOL', '不支持的闪卡调度设置工具', `Unsupported flashcard scheduler settings tool: ${call.name}`));
      }
    } catch (caught) { error = errorText(caught); }
    const durationMs = Math.floor(performance.now() - started);
    if (error === undefined) ctx.emitToolCallEnd({ result: output, durationMs });
    else ctx.emitToolCallError(error);
    const result = toolResult(call, ctx, durationMs, output, error);
    try { ctx.saveToolBlock(result); }
    catch (caught) { ctx.warn(`[FsrsSettingsExecutor] Failed to persist tool block: ${errorText(caught)}`); }
    return result;
  }
}

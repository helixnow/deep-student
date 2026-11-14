/**
 * ask_user_executor.rs:30–297 `AskUserExecutor`.
 *
 * The pending-answer map is owned by the chat plugin (`chat_v2_ask_user_respond`); this executor
 * registers a resolver there and waits without a timeout, exactly like the Rust oneshot channel.
 */
import { registerAskUserCallback, type AskUserResponse, type ExecutionContext, type ToolCall,
  type ToolResultInfo, type ToolSensitivity } from '../../chat/api.ts';
import { get_json_array_arg, strip_tool_namespace, type JsonValue } from '../../../platform/errors/api.ts';
import { rustTrim } from '../../../platform/util/index.ts';

export const ASK_USER_EXECUTOR_NAME = 'AskUserExecutor';
export const ASK_USER_TOOL_NAME = 'ask_user';

type Log = (message: string) => void;
interface AskUserOption { label: string; reason?: string }

const field = (args: unknown, key: string): unknown =>
  args !== null && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>)[key] : undefined;
const trimmedNonEmpty = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = rustTrim(value);
  return trimmed === '' ? null : trimmed;
};
const rustDebugStrings = (values: readonly string[]) => `[${values.map(value => JSON.stringify(value)).join(', ')}]`;

/** ask_user_executor.rs:39–75 `parse_ask_user_options`. */
export function parseAskUserOptions(args: unknown): AskUserOption[] {
  const items = get_json_array_arg(args as JsonValue, 'options') ?? [];
  const options: AskUserOption[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      const label = trimmedNonEmpty(item);
      if (label !== null) options.push({ label });
      continue;
    }
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    // `.or_else` chain: the first present *string* wins, then trim/non-empty filters it.
    const raw = [item.label, item.value, item.text].find(value => typeof value === 'string');
    const label = trimmedNonEmpty(raw);
    if (label === null) continue;
    const reason = trimmedNonEmpty(item.reason);
    options.push(reason === null ? { label } : { label, reason });
  }
  return options;
}

/** serde_json `as_u64`: a non-negative integer that fits u64. */
function asU64(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

const DEFAULT_NO_SIGNAL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_NO_SIGNAL_TIMEOUT_MS = 30 * 60 * 1000;

export class AskUserExecutor {
  private readonly info: Log;
  private readonly warn: Log;
  private readonly defaultNoSignalTimeoutMs: number;
  constructor(log: { info: Log; warn: Log }, defaultNoSignalTimeoutMs: number = DEFAULT_NO_SIGNAL_TIMEOUT_MS) {
    this.info = log.info;
    this.warn = log.warn;
    this.defaultNoSignalTimeoutMs = defaultNoSignalTimeoutMs;
  }

  canHandle(toolName: string): boolean { return strip_tool_namespace(toolName) === ASK_USER_TOOL_NAME; }

  async execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResultInfo> {
    const started = performance.now();
    const args = call.arguments;
    const questionValue = field(args, 'question');
    const question = typeof questionValue === 'string' ? questionValue : '';
    const options = parseAskUserOptions(args);
    const multipleValue = field(args, 'multiple');
    const multiple = typeof multipleValue === 'boolean' ? multipleValue : false;
    const allowCustomValue = field(args, 'allowCustom');
    const allowCustom = typeof allowCustomValue === 'boolean' ? allowCustomValue : true;
    const timeoutSeconds = asU64(field(args, 'timeoutSeconds'));
    const htmlValue = field(args, 'html');
    const html = typeof htmlValue === 'string' ? htmlValue : undefined;
    const uiValue = field(args, 'ui');
    const ui = typeof uiValue === 'string' ? uiValue : undefined;
    const titleValue = field(args, 'title');
    const title = typeof titleValue === 'string' ? titleValue : undefined;
    this.info(`[AskUserExecutor] Asking user: question='${question}', options=${rustDebugStrings(options.map(option => option.label))}, multiple=${multiple}, allow_custom=${allowCustom}, timeout=${timeoutSeconds === null ? 'None' : `Some(${timeoutSeconds})`}s`);

    // Register before the block appears (chat ask-user.ts contract), so an immediate answer is never lost.
    const hasInteractiveFrontend = typeof ctx.hasFrontend !== 'function' || ctx.hasFrontend();
    const pending = hasInteractiveFrontend
      ? this.waitForAnswer(call.id, ctx.cancellation_token, timeoutSeconds)
      : Promise.resolve<AskUserResponse>({
          toolCallId: call.id,
          selectedTexts: [],
          selectedIndices: [],
          customText: null,
          source: 'channel_closed',
        });
    ctx.emitToolCallStart(call.name, call.arguments, call.id);
    if (!hasInteractiveFrontend) {
      this.warn('[AskUserExecutor] Non-interactive execution context (no frontend), returning channel_closed without blocking');
    } else if (timeoutSeconds !== null) {
      this.info(
        ctx.cancellation_token === null
          ? `[AskUserExecutor] No cancellation token; honoring timeout=${timeoutSeconds}s fallback guard`
          : `[AskUserExecutor] LLM requested timeout=${timeoutSeconds}s, ignoring (user decisions have no timeout)`
      );
    }
    const answer = await pending;
    const durationMs = Math.trunc(performance.now() - started);
    const output = {
      question,
      selected: answer.selectedTexts,
      selected_indices: answer.selectedIndices,
      custom_text: answer.customText,
      source: answer.source,
      options,
      multiple,
      ...(html !== undefined ? { html } : {}),
      ...(ui !== undefined ? { ui } : {}),
      ...(title !== undefined ? { title } : {}),
    };
    const result: ToolResultInfo = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name,
      input: call.arguments, output, success: true, durationMs };
    ctx.emitToolCallEnd({ result: output, durationMs });
    try { ctx.saveToolBlock(result); }
    catch (cause) { this.warn(`[AskUserExecutor] Failed to save tool block: ${cause instanceof Error ? cause.message : String(cause)}`); }
    this.info(`[AskUserExecutor] Completed: selected=${rustDebugStrings(answer.selectedTexts)}, source='${answer.source}', duration=${durationMs}ms`);
    return result;
  }

  /**
   * Rust awaits the receiver forever; the future is dropped on cancellation. Here the registry
   * rejects the cancelled call, and the resolver is withdrawn so no waiter outlives its turn.
   */
  private waitForAnswer(
    toolCallId: string,
    signal: AbortSignal | null,
    timeoutSeconds: number | null = null,
  ): Promise<AskUserResponse> {
    return new Promise(resolve => {
      let onAbort: (() => void) | undefined;
      let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
      const unregister = registerAskUserCallback(toolCallId, response => {
        if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
        if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
        this.info(`[AskUserExecutor] Received user response: selected=${rustDebugStrings(response.selectedTexts)}, source='${response.source}'`);
        resolve(response);
      });
      if (signal === null) {
        const timeoutMs =
          timeoutSeconds !== null && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
            ? Math.min(Math.max(Math.trunc(timeoutSeconds * 1000), 1000), MAX_NO_SIGNAL_TIMEOUT_MS)
            : this.defaultNoSignalTimeoutMs;
        fallbackTimer = setTimeout(() => {
          unregister();
          this.warn(`[AskUserExecutor] No cancellation token and no user response within ${timeoutMs}ms, closing channel`);
          resolve({ toolCallId, selectedTexts: [], selectedIndices: [], customText: null, source: 'channel_closed' });
        }, timeoutMs);
        if (typeof fallbackTimer === 'object' && fallbackTimer !== null && 'unref' in fallbackTimer) {
          fallbackTimer.unref();
        }
        return;
      }
      onAbort = () => {
        if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
        unregister();
        this.warn('[AskUserExecutor] Channel closed (session ended), reporting no response');
        resolve({ toolCallId, selectedTexts: [], selectedIndices: [], customText: null, source: 'channel_closed' });
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  sensitivityLevel(_toolName: string): ToolSensitivity { return 'low'; }
  name(): string { return ASK_USER_EXECUTOR_NAME; }
}

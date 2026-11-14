/**
 * `chat_v2/tools/executor.rs` 与 `chat_v2/types.rs` 的公共工具类型。
 *
 * 只放跨工具模块共享、与宿主无关的纯类型/纯函数；执行上下文里与
 * kernel/DB 绑定的依赖由各工具模块按需声明，避免生产代码直接依赖 kernel。
 */
export type JsonValue =
  | null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** `ToolCall`（dstu-core agent）。 */
export interface ToolCall<Input = JsonValue> {
  id: string;
  name: string;
  arguments: Input;
}

/** `ToolResultInfo`（serde rename_all = camelCase，Option 省略）。 */
export interface ToolResultInfo<Input = JsonValue> {
  toolCallId?: string;
  blockId?: string;
  toolName: string;
  input: Input;
  output: JsonValue;
  success: boolean;
  error?: string;
  durationMs?: number;
  reasoningContent?: string;
  thoughtSignature?: string;
}

/** `ToolSensitivity`（serde rename_all = snake_case，默认 low）。 */
export type ToolSensitivity = 'low' | 'medium' | 'high';

/** `ToolConcurrency`（serde rename_all = snake_case，默认 serial）。 */
export type ToolConcurrency = 'read_only' | 'safe_parallel' | 'serial';

/** `strip_tool_namespace`：先剥 `builtin-`，再剥 `mcp_`，否则原样返回。 */
export function stripToolNamespace(toolName: string): string {
  if (toolName.startsWith('builtin-')) return toolName.slice('builtin-'.length);
  if (toolName.startsWith('mcp_')) return toolName.slice('mcp_'.length);
  return toolName;
}

/** `ToolResultInfo::success` 的序列化形态（仅保留非空 Option）。 */
export function successResult<Input>(
  toolCallId: string | null,
  blockId: string | null,
  toolName: string,
  input: Input,
  output: JsonValue,
  durationMs: number,
): ToolResultInfo<Input> {
  const result: ToolResultInfo<Input> = { toolName, input, output, success: true, durationMs };
  if (toolCallId !== null && toolCallId !== '') result.toolCallId = toolCallId;
  if (blockId !== null && blockId !== '') result.blockId = blockId;
  return result;
}

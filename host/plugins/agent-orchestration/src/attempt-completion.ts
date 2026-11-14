/** attempt_completion.rs:39–194. */

export const ATTEMPT_COMPLETION_TOOL_NAME = 'attempt_completion';

/** attempt_completion.rs:26–31 `TOOL_DESCRIPTION` (the model-facing text). */
export const ATTEMPT_COMPLETION_TOOL_DESCRIPTION = `当任务完成时，使用此工具向用户展示最终结果。
这将终止当前的 Agent 循环，不再执行后续工具调用。
只有在确认任务已完成时才应该调用此工具。
如果任务产生了文件产物，result 中应包含产物清单（相对路径 + 一句话用途），
并同时在 artifacts 参数中显式申报产物（相对路径 + 可选 sha256）；
后端验收器（TaskFinalizer）会核对申报产物真实存在，验收结论写入完成块。`;

export interface DeclaredArtifact {
  path: string;
  sha256: string | null;
  rootId: string | null;
}

export interface AttemptCompletionParams {
  result: string;
  command: string | null;
  artifacts: DeclaredArtifact[] | null;
}

export interface AttemptCompletionResult {
  completed: boolean;
  result: string;
  command: string | null;
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function parseArtifacts(value: unknown): DeclaredArtifact[] {
  if (!Array.isArray(value)) throw new Error('artifacts 参数格式错误: expected an array');
  return value.map((item, index) => {
    const object = objectOf(item);
    if (object === null) throw new Error(`artifacts 参数格式错误: item ${index} must be an object`);
    if (typeof object.path !== 'string') throw new Error(`artifacts 参数格式错误: item ${index} missing path`);
    return {
      path: object.path,
      sha256: typeof object.sha256 === 'string' ? object.sha256 : null,
      rootId: typeof object.root_id === 'string' ? object.root_id : null,
    };
  });
}

export function parseAttemptCompletionParams(value: unknown): AttemptCompletionParams {
  const args = objectOf(value);
  if (args === null) throw new Error('缺少必需参数: result');
  const result = args.result;
  if (typeof result !== 'string') throw new Error('缺少必需参数: result');
  const command = typeof args.command === 'string' ? args.command : null;
  const artifacts = args.artifacts === undefined || args.artifacts === null
    ? null : parseArtifacts(args.artifacts);
  return { result, command, artifacts };
}

export function executeAttemptCompletion(params: AttemptCompletionParams): AttemptCompletionResult {
  return { completed: true, result: params.result, command: params.command };
}

export function attemptCompletionSchema(): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: ATTEMPT_COMPLETION_TOOL_NAME,
      description: ATTEMPT_COMPLETION_TOOL_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          result: { type: 'string', description: '任务完成的最终结果或总结，将展示给用户' },
          command: { type: 'string', description: '建议用户执行的命令（可选），如编译、运行等' },
          artifacts: {
            type: 'array',
            description: '任务产生的文件产物清单（可选）。申报后后端验收器会核对产物真实存在与内容哈希。',
            items: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description: '产物相对路径（相对 runtime root，默认 artifacts root；拒绝绝对路径与 ..）',
                },
                sha256: { type: 'string', description: '产物内容的 SHA-256 hex（可选；申报即校验）' },
                root_id: {
                  type: 'string',
                  description: '产物所在 runtime root（可选，默认 artifacts；可选 workspace/temp/authorized_*/skill:*）',
                },
              },
              required: ['path'],
            },
          },
        },
        required: ['result'],
      },
    },
  };
}

export function isAttemptCompletion(toolName: string): boolean {
  const bare = toolName.startsWith('builtin-') ? toolName.slice('builtin-'.length)
    : toolName.startsWith('builtin:') ? toolName.slice('builtin:'.length) : toolName;
  return bare === ATTEMPT_COMPLETION_TOOL_NAME;
}

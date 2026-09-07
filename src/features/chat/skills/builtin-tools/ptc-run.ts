/**
 * PTC 程序化工具组合技能（G05-P1）
 *
 * 允许 AI agent 提交一段 Starlark 脚本，在脚本内通过 `call(tool, args)`
 * 串行组合多个只读内置工具调用（循环 / 分支 / 聚合中间结果），只把最终
 * 答案交还给模型，避免多轮工具往返撑爆上下文。
 *
 * 每个 `call` 都重新经过中央准入（kill-switch / 白名单 / 审批），工具面
 * 为只读白名单（检索 / 记忆读取 / 资源读取 / 题库 / 复习统计等），
 * 写工具、shell、connector、子代理一律 fail-closed 拒绝。
 *
 * @see src-tauri/src/chat_v2/tools/ptc_executor.rs
 * @see src-tauri/src/chat_v2/tools/ptc_runtime.rs
 */

import type { SkillDefinition } from '../types';

export const ptcRunSkill: SkillDefinition = {
  id: 'ptc-run',
  name: 'ptc-run',
  description:
    'PTC 程序化工具组合能力：提交一段 Starlark 脚本，在脚本内用 call(tool, args) 串行组合多个只读工具调用并聚合结果。适合需要多步检索/过滤/合并的场景，一次调用替代多轮工具往返。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 1,
  location: 'builtin',
  sourcePath: 'builtin://ptc-run',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# PTC 程序化工具组合

使用 \`builtin-ptc_run\` 运行一段 **Starlark** 脚本（Python 子集：def / if / for / 列表字典推导式，无 while、无 IO、无 import），脚本内通过全局函数 \`call(tool, args)\` 调用白名单内的只读工具。

## 脚本约定

- 脚本的**最后一个表达式的值**就是返回值（JSON 可序列化：dict / list / str / 数字 / bool / None）。
- \`call(tool, args)\` 参数：
  - \`tool\`：工具名，\`builtin-\` 前缀可省略（如 \`"rag_search"\` 等价 \`"builtin-rag_search"\`）。
  - \`args\`：Starlark dict（推荐），或 JSON 字符串。
- 返回值是 envelope dict：
  - 成功：\`{"ok": True, "output": <工具的 JSON 输出>}\`
  - 失败：\`{"ok": False, "error": "<错误信息>"}\` —— 工具失败**不会**中断脚本，脚本自行决定容错（如换工具重试）。
- 可用标准库：\`json.encode\` / \`json.decode\`、\`struct()\`，以及 Starlark 内建函数（len/range/enumerate/sorted/str 方法等）。**没有** print / load / 文件与网络 IO。
- 策略违规（调用白名单外工具、超过 max_calls、参数非法）会直接中断脚本报错——请在脚本内只使用白名单工具。

## 示例：多源检索后合并去重

\`\`\`python
results = []
for kw in ["RAG 评估指标", "retrieval augmented generation evaluation"]:
    res = call("builtin-rag_search", {"query": kw, "top_k": 3})
    if res["ok"]:
        results.extend(res["output"].get("results", []))
{"total": len(results), "titles": [r.get("title", "") for r in results]}
\`\`\`

## 工具面（只读白名单，fail-closed）

检索：unified_search / rag_search / web_search / web_fetch / arxiv_search / scholar_search；
记忆与资源：memory_read / memory_list / resource_list / resource_read / resource_search / folder_list / dstu_list_trash；
待办与题库：user_todo_list_lists / user_todo_list_items / user_todo_get_summary / user_todo_search / user_todo_list_trash / qbank_list / qbank_list_questions / qbank_get_question / qbank_get_stats / qbank_get_next_question；
学习与复习统计：learning_overview / pomodoro_today_stats / pomodoro_daily_stats / review_get_due / review_stats；
系统观测：settings_get / model_assignments_get / llm_usage_query / backup_status / backup_job_status / sync_status / index_status。
（全部需加 \`builtin-\` 前缀或省略前缀均可。写工具 / shell / connector / 子代理 / tool_pack / ptc_run 一律拒绝。）

## 限制

- max_calls：默认 50，上限 200（超顶中断脚本）。
- timeout_secs：默认 120 秒，上限 600 秒（wall-clock）。
- 脚本大小上限 64KB。
- 返回值 > 4KB 自动物化为会话 artifacts 文件，只返回 object_handle + 前 2KB 预览（分页回读能力在后续版本提供）。

## 结果

\`\`\`json
{
  "status": "ok",
  "result": { "...": "脚本最后一个表达式的值" },
  "calls_used": 3,
  "duration_ms": 812,
  "trace": [
    {"seq": 0, "tool": "builtin-rag_search", "args_hash": "sha256:…", "duration_ms": 210, "result_bytes": 1820, "ok": true}
  ]
}
\`\`\`

\`status\` 可能为 \`ok\` / \`error\`（脚本错误或被拒）/ \`timeout\` / \`cancelled\`；失败时 \`trace\` 仍保留已发生的调用轨迹，可用于排障后改写脚本重试。
`,
  embeddedTools: [
    {
      name: 'builtin-ptc_run',
      description:
        'Runs a Starlark script through the Rust backend executor, composing multiple read-only built-in tool calls via call(tool, args) with central admission re-applied to every call.',
      inputSchema: {
        type: 'object',
        properties: {
          script: {
            type: 'string',
            description:
              'Starlark script source. The value of the last expression is returned. Use call(tool, args) to invoke allowlisted read-only tools.',
            maxLength: 65536,
          },
          max_calls: {
            type: 'integer',
            description: 'Maximum number of call() invocations (default 50, hard cap 200).',
            minimum: 1,
            maximum: 200,
          },
          timeout_secs: {
            type: 'integer',
            description: 'Wall-clock timeout in seconds (default 120, hard cap 600).',
            minimum: 1,
            maximum: 600,
          },
        },
        required: ['script'],
      },
    },
  ],
};

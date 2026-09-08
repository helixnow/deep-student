/**
 * PTC 程序化工具组合技能（G05-P1/P2）
 *
 * 允许 AI agent 提交一段 Starlark 脚本，在脚本内通过 `call(tool, args)`
 * 串行组合多个只读内置工具调用（循环 / 分支 / 聚合中间结果），只把最终
 * 答案交还给模型，避免多轮工具往返撑爆上下文。
 *
 * 每个 `call` 都重新经过中央准入（kill-switch / 白名单 / 审批），工具面
 * 为只读白名单（检索 / 记忆读取 / 资源读取 / 题库 / 复习统计等），
 * 写工具、shell、connector、子代理一律 fail-closed 拒绝。
 *
 * G05-P2 新增宿主函数 `object_read(handle_or_locator, offset, limit)`：
 * 分页读回已物化到会话 artifacts 根的 TaskObject 内容（大 return 值不再
 * 只有 2KB 预览），与 `call()` 共享 max_calls 预算与 trace。
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

## object_read：分页读回物化结果

\`call()\` 输出或本工具返回值里的物化对象（\`object_handle\`，含 \`locator\` 与 \`capabilities\`）可分页读回完整内容：

\`object_read(handle_or_locator, offset=0, limit=8192)\` → \`{content, encoding, offset, limit, next_offset, total_size, eof, sha256}\`

- 第一个参数：\`object_handle\` dict（要求 \`capabilities.readable\` 为 True，否则结构化报错），或显式 \`{"root_id": "artifacts", "relative_path": "ptc/xxx.json"}\`（camelCase 键同受支持）。
- \`offset\`/\`limit\` 是**字节**语义；\`limit\` 上限 32KB/页（超出自动收敛）。
- 文本页 \`encoding == "utf-8"\`：按 UTF-8 字符边界截断，绝不切半字符；翻页一律用上一页的 \`next_offset\`，逐页拼接即为原文。
- 二进制页 \`encoding == "base64"\`：每页独立 base64，需逐页解码后再拼接字节。
- \`sha256\` 是整文件字节指纹：拼完用 \`sha256\` 校验完整性；\`eof == True\` 或 \`offset >= total_size\` 时终止循环。
- \`object_read\` 是宿主函数不是工具（不占工具白名单），但**与 call() 共享 max_calls 预算**——分页读取记得把预算算进去。

\`\`\`python
# 读回上一段 ptc_run 物化的大结果（模型从返回值拿到 object_handle）
locator = {"root_id": "artifacts", "relative_path": "ptc/ptc-b123-1725750000000.json"}
chunks = []
offset = 0
sha = ""
for _i in range(50):
    page = object_read(locator, offset=offset, limit=8192)
    chunks.append(page["content"])
    offset = page["next_offset"]
    sha = page["sha256"]
    if page["eof"]:
        break
{"full_text": "".join(chunks), "sha256": sha}
\`\`\`

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

- max_calls：默认 50，上限 200（超顶中断脚本；call() 与 object_read() 同账本计数）。
- timeout_secs：默认 120 秒，上限 600 秒（wall-clock）。
- 脚本大小上限 64KB。
- 返回值 > 4KB 自动物化为会话 artifacts 文件，返回 object_handle + 前 2KB 预览；在后续 ptc_run 脚本里用 object_read 分页读回全文（见上文）。

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
              'Starlark script source. The value of the last expression is returned. Use call(tool, args) to invoke allowlisted read-only tools, and object_read(handle_or_locator, offset, limit) to page back materialized task objects.',
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

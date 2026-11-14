/**
 * Rust `dstu-memory/src/memory/query_rewriter.rs`.
 *
 * Dead in Rust production as well (audit-L17-Q1): the only entry is
 * `search_with_rerank(.., use_query_rewrite = true)` (service.rs:2597-2608), and every
 * production caller passes `false` (handlers.rs:244, memory_executor.rs:528/536). The Rust
 * tests are approved `obsolete:dead-in-rust` (migration/approvals.d/C1-app.json:48-49).
 * Intentionally not wired into the Host retrieval path; do not add a model call here.
 */
export interface QueryRewriteResult {
  optimized_query: string;
  sub_queries: string[];
  key_concepts: string[];
  was_rewritten: boolean;
}

export function noRewriteResult(originalQuery: string): QueryRewriteResult {
  return { optimized_query: originalQuery, sub_queries: [], key_concepts: [], was_rewritten: false };
}

/** Rust `rewrite` guard: `original_query.len() < 10` is **bytes**, not chars. */
export function shouldSkipRewrite(originalQuery: string): boolean {
  return new TextEncoder().encode(originalQuery).length < 10;
}

function trimFence(value: string): string {
  let cleaned = value.trim();
  if (cleaned.startsWith('```json')) cleaned = cleaned.slice('```json'.length);
  if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
  return cleaned.trim();
}

/** Rust `parse_rewrite_response`; returns null when the JSON value cannot be parsed. */
export function parseRewriteResponse(response: string, originalQuery: string): QueryRewriteResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimFence(response));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const optimized = typeof record.optimized_query === 'string' ? record.optimized_query : originalQuery;
  const stringArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  return {
    optimized_query: optimized,
    sub_queries: stringArray(record.sub_queries),
    key_concepts: stringArray(record.key_concepts),
    was_rewritten: typeof record.was_rewritten === 'boolean' ? record.was_rewritten : true,
  };
}

export function buildRewritePrompt(originalQuery: string): string {
  return `你是一个查询优化专家。请将用户的原始查询优化为更适合向量检索的形式。

## 原始查询
${originalQuery}

## 任务
1. 分析查询意图
2. 提取关键概念
3. 生成优化后的查询（更具体、更适合语义搜索）
4. 如果查询复杂，可以拆分为多个子查询

## 输出格式（JSON）
\`\`\`json
{
  "optimized_query": "优化后的主查询",
  "sub_queries": ["子查询1", "子查询2"],
  "key_concepts": ["概念1", "概念2"],
  "was_rewritten": true
}
\`\`\`

## 注意事项
- 如果原查询已经很好，was_rewritten 设为 false，optimized_query 返回原查询
- 保持查询的核心意图不变
- 子查询用于多角度检索，通常 1-3 个即可

请直接输出 JSON，不要添加额外说明。`;
}

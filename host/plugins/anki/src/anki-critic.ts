/**
 * # 生成后 Grounded judge / LLM critic pass（opt-in，默认关闭）
 *
 * 迁移自 `src-tauri/crates/dstu-anki/src/anki_critic.rs`（非测试部分，1-1052 行）。
 *
 * 流式制卡任务收尾（`Ok(stats)`）后，对该任务已入库的全部非错误卡做**一次**
 * JSON 裁决，以任务的 `content_segment`（源材料）为对照，判定三类问题：
 *
 * 1. **事实性**（grounded）：卡片答案与源材料矛盾 / 无中生有；
 * 2. **最小信息原则**：一卡多事实、front 过载、空泛提问；
 * 3. **重复**：同批语义重复卡。
 *
 * ## 裁决协议（verdict）
 *
 * 模型对每张卡输出 `keep | revise | flag`：
 *
 * - `keep`：不动；
 * - `revise`：用模型给出的 `revised` 字段重写卡片，走既有库 CAS 持久化
 *   （id/task_id 永不变更；送审后用户有编辑则拒绝覆盖），写入 `_qa_flags`
 *   审计条目 `llm_critic_revised`，并写入独立的 `_content_provenance` 溯源戳
 *   （actor=llm_critic）——溯源不受 `enable_qa_pass` 门控剥离；
 * - `flag`：仅在 `extra_fields["_qa_flags"]` 追加 `llm_critic` 条目留痕，
 *   卡片内容不动（绝不丢卡）。
 *
 * `enable_qa_pass=false`（"不要 QA 留痕"公开契约）时裁决与统计照常执行，
 * 但所有 `_qa_flags` 写入（flag 留痕 / revise 审计 / relint）一律不落盘；
 * revise 的内容修订仍写回，且 `_content_provenance` 溯源戳一并落盘。
 *
 * ## 设计硬约束
 *
 * - **默认关闭**：`criticOptionsFromOptionsJson` 解析同一份
 *   `anki_generation_options_json`（serde-default 二次解析）。
 *   `enable_critic_pass` / `enable_llm_critic`（别名）缺省即 false。
 * - **LLM 失败必须降级**：模型调用失败/超时/JSON 解析失败时，
 *   `runCriticPass` 返回 `degraded` 摘要，全部卡片视同 keep，
 *   **绝不**让 critic 失败拖垮整批制卡（编排器永不向上抛错）。
 * - **越权改 id 拒绝**：裁决中出现不属于本任务的 card_id 一律丢弃并计数。
 * - **token 预算**：prompt 按字符预算裁剪（源材料截断、单字段截断、
 *   超预算卡片跳过并计数）。
 * - **最多修订轮 1**：`CriticConfig.max_revision_rounds` 被硬钳位到 1。
 * - **grounded 同源金标**：`collectGoldReferences` 经金标集挖掘同文档兄弟卡
 *   的用户修正记录（改前 = 劣化、改后 = 金标），注入 0-N 对 `ReferenceCard`；
 *   有金标时 prompt 切换为对照金标评审（金标区受独立字符预算与对数上限截断，
 *   绝不挤占待评审卡），无金标时保持内置规则 rubric。
 *   收集失败退化为空列表，绝不拖垮制卡收尾。
 *
 * ## 依赖注入边界
 *
 * Rust 侧直接调用 `crate::database::Database`、`crate::llm_manager::LLMManager`
 * 与 `crate::anki_gold_set`。这些模块在本 lane 中尚未发布，故这里只声明
 * 最小接口（`CriticCardStore` / `AnkiCriticLlm` / `GoldSetMining`）并由编排器
 * 注入；纯逻辑与全部 54 条单测不依赖任何外部服务。
 */
import type { AnkiCard, DocumentTask } from '../../../../contracts/ipc/generated/_shared.ts';
import { isAppErrorValue } from '../../../platform/errors/api.ts';
import { CONTENT_PROVENANCE_FIELD, PROVENANCE_ACTOR_USER } from './anki-cards.ts';
import {
  CRITIC_REVISED_QA_CODE,
  ORIGINAL_GENERATION_FIELD,
  PROVENANCE_ACTOR_IMPORT,
  PROVENANCE_ACTOR_LLM_CRITIC,
  PROVENANCE_ACTOR_SYNC,
  extractOriginalFromExtras,
  hasCriticRevisionMarker,
  insertContentProvenance,
  isLlmCriticActor,
  parseContentProvenance,
  type CardSnapshot,
  type ContentProvenance,
  type GoldCandidate,
  type GoldLabel,
  type GoldMiningConfig,
  type GoldSample,
  type RepairPair,
} from './anki-gold-set.ts';

export type {
  CardSnapshot,
  ContentProvenance,
  GoldCandidate,
  GoldLabel,
  GoldMiningConfig,
  GoldSample,
  RepairPair,
} from './anki-gold-set.ts';
import { qaPassEnabled, structuredOutputOptionsFromOptionsJson } from './anki-protocol.ts';
import {
  defaultLintConfig,
  lintCard,
  mergeFlags,
  QA_FLAGS_FIELD,
  type LintConfig,
  type LintIssue,
} from './anki-qa-lint.ts';
import { nowRfc3339 } from './time.ts';

/** critic 裁决的 `_qa_flags` 条目 code（flag 裁决留痕）。 */
import {
  CRITIC_FLAG_CODE,
  CRITIC_REVISED_CODE,
  MAX_REVISION_ROUNDS_HARD_CAP,
  CRITIC_MODEL_TIMEOUT_SECS,
  SEVERITY_INFO,
  SEVERITY_WARN,
  buildCriticPrompt,
  criticConfigFromOptions,
  criticEnabled,
  criticOptionsFromOptionsJson,
  defaultCriticConfig,
  defaultCriticOptions,
  defaultCriticSummary,
  defaultParsedVerdicts,
  effectiveRevisionRounds,
  noteRoutingDecision,
  parseRoutingMode,
  referenceCardFromRepairPair,
  revisedFieldsHasContent,
  type AnkiModelRole,
  type CardVerdict,
  type CriticConfig,
  type CriticOptions,
  type CriticPrompt,
  type CriticSummary,
  type ParsedVerdicts,
  type ReferenceCard,
  type RevisedFields,
  type RoleDecision,
  type RoutingMode,
  type SlotKind,
  type Verdict,
} from './anki-critic-prompt.ts';
export * from './anki-critic-prompt.ts';

// ============================================================================
// 响应解析（含越权 id 拒绝）
// ============================================================================

/** `Result<T, String>` 的 wire 形态（Rust `Result` 的显式映射）。 */
export type CriticResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** 从模型输出中定位首个 JSON 对象（剥离 markdown 代码围栏与前后文）。 */
function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < 0) return null;
  if (end <= start) return null;
  return raw.slice(start, end + 1);
}

/** `RevisedFields` 的 serde 解码：缺失/null → 缺省；类型不符 → 整体非法。 */
function decodeRevisedFields(value: unknown): RevisedFields | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  const field = (key: string): string | null | undefined => {
    if (!Object.hasOwn(object, key)) return null;
    const raw = object[key];
    if (raw === null) return null;
    return typeof raw === 'string' ? raw : undefined;
  };
  const front = field('front');
  const back = field('back');
  const text = field('text');
  if (front === undefined || back === undefined || text === undefined) return undefined;
  return { front, back, text };
}

/** 单条裁决的 serde 解码；返回 null 表示该条目非法（计入 `rejected_invalid`）。 */
function decodeCardVerdict(item: unknown): CardVerdict | null {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
  const object = item as Record<string, unknown>;
  const cardId = object.card_id;
  if (typeof cardId !== 'string') return null;
  const verdict = object.verdict;
  if (verdict !== 'keep' && verdict !== 'revise' && verdict !== 'flag') return null;

  let reasons: string[] = [];
  if (Object.hasOwn(object, 'reasons')) {
    const rawReasons = object.reasons;
    if (!Array.isArray(rawReasons) || rawReasons.some((reason) => typeof reason !== 'string')) return null;
    reasons = [...(rawReasons as string[])];
  }

  let revised: RevisedFields | null = null;
  if (Object.hasOwn(object, 'revised')) {
    const decoded = decodeRevisedFields(object.revised);
    if (decoded === undefined) return null;
    revised = decoded;
  }
  return { card_id: cardId, verdict, reasons, revised };
}

/**
 * 解析 critic JSON 响应。
 *
 * - `allowedIds`：本任务实际送审的卡片 id 白名单。白名单外的裁决
 *   （模型越权/幻觉 id）一律拒绝并计入 `rejected_unknown_ids`；
 * - verdict 值非法的条目丢弃计入 `rejected_invalid`；
 * - `revise` 但 `revised` 缺失/全空 → **降级为 flag**（有问题的信号仍保留，
 *   但绝不用空载荷覆盖卡片内容）；
 * - 同一 card_id 出现多条裁决时只取第一条（后续按非法条目计数）；
 * - 整体不是合法 JSON / 缺 `verdicts` 数组 → `Err`（调用方走降级路径）。
 */
export function parseCriticResponse(
  raw: string,
  allowedIds: ReadonlySet<string>,
): CriticResult<ParsedVerdicts> {
  const jsonText = extractJsonObject(raw);
  if (jsonText === null) return { ok: false, error: '响应中未找到 JSON 对象' };

  let value: unknown;
  try {
    value = JSON.parse(jsonText) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `JSON 解析失败: ${message}` };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: '缺少 verdicts 数组' };
  }
  const items = (value as Record<string, unknown>).verdicts;
  if (!Array.isArray(items)) return { ok: false, error: '缺少 verdicts 数组' };

  const out = defaultParsedVerdicts();
  const seen = new Set<string>();
  for (const item of items) {
    const verdict = decodeCardVerdict(item);
    if (verdict === null) {
      out.rejected_invalid += 1;
      continue;
    }
    if (!allowedIds.has(verdict.card_id)) {
      out.rejected_unknown_ids += 1;
      continue;
    }
    if (seen.has(verdict.card_id)) {
      out.rejected_invalid += 1;
      continue;
    }
    seen.add(verdict.card_id);
    // revise 无有效载荷 → 降级 flag，理由留痕
    if (verdict.verdict === 'revise' && (verdict.revised === null || !revisedFieldsHasContent(verdict.revised))) {
      verdict.verdict = 'flag';
      verdict.revised = null;
      verdict.reasons.push('critic 给出 revise 但未提供有效修订内容，降级为 flag');
    }
    out.verdicts.push(verdict);
  }
  return { ok: true, value: out };
}

// ============================================================================
// 裁决落地计划（纯函数，DB 写入由编排器执行）
// ============================================================================

/** 落地计划：待持久化的卡片 + 统计。 */
export interface CriticPlan {
  /** 需要写回 DB 的卡片（revise 重写 / flag 留痕），id/task_id 与原卡一致。 */
  updates: AnkiCard[];
  kept: number;
  revised: number;
  flagged: number;
}

/** `CriticPlan::default()`。 */
export function defaultCriticPlan(): CriticPlan {
  return { updates: [], kept: 0, revised: 0, flagged: 0 };
}

function criticIssue(code: string, message: string, severity: LintIssue['severity']): LintIssue {
  return { code, field: 'card', message, severity };
}

/** 深拷贝卡片（`AnkiCard::clone`，含 `extra_fields`/`tags`/`images`）。 */
function cloneCard(card: AnkiCard): AnkiCard {
  return {
    ...card,
    tags: [...card.tags],
    images: [...card.images],
    extra_fields: { ...card.extra_fields },
  };
}

/**
 * 将裁决映射为具体的卡片更新（纯函数，不触 DB）。
 *
 * - `keep` / 无裁决：不产生写入；
 * - `flag`：仅向 `_qa_flags` 追加 `llm_critic` 条目（Warn）；
 * - `revise`：套用 `revised` 中的非空字段（id/task_id/created_at 等元数据
 *   一律保持原值），追加 `llm_critic_revised` 审计条目（Info），写入
 *   `_content_provenance`（actor=llm_critic, code=llm_critic_revised——
 *   独立于 `_qa_flags` 的溯源事实，**不受** `enable_qa_pass` 门控剥离），
 *   并对修订后的内容重跑一遍确定性 lint（revise 也可能引入占位符等问题）。
 *
 * 修订轮约束在此不体现——本函数只被每任务的**单轮** critic 调用一次，
 * 轮数由 `effectiveRevisionRounds` 在编排器处钳位。
 */
export function planUpdates(
  cards: readonly AnkiCard[],
  verdicts: readonly CardVerdict[],
  now: () => string = nowRfc3339,
): CriticPlan {
  const plan = defaultCriticPlan();
  for (const card of cards) {
    const verdict = verdicts.find((candidate) => candidate.card_id === card.id);
    if (verdict === undefined) {
      plan.kept += 1;
      continue;
    }
    if (verdict.verdict === 'keep') {
      plan.kept += 1;
      continue;
    }
    if (verdict.verdict === 'flag') {
      const updated = cloneCard(card);
      const issue = criticIssue(
        CRITIC_FLAG_CODE,
        `LLM critic 标记：${joinReasons(verdict.reasons)}`,
        SEVERITY_WARN,
      );
      mergeFlags(updated.extra_fields, [issue]);
      plan.updates.push(updated);
      plan.flagged += 1;
      continue;
    }
    const revised = verdict.revised;
    if (revised === null || revised === undefined) {
      // parse 层已降级，这里理论上不可达；防御性按 keep 处理
      plan.kept += 1;
      continue;
    }
    const updated = cloneCard(card);
    const front = revised.front === null || revised.front === undefined ? null : revised.front.trim();
    if (front !== null && front !== '') {
      updated.front = front;
    }
    const back = revised.back === null || revised.back === undefined ? null : revised.back.trim();
    if (back !== null && back !== '') {
      updated.back = back;
    }
    const text = revised.text === null || revised.text === undefined ? null : revised.text.trim();
    if (text !== null && text !== '') {
      updated.text = text;
      updated.extra_fields.text = text;
    }
    const audit = criticIssue(
      CRITIC_REVISED_CODE,
      `LLM critic 修订：${joinReasons(verdict.reasons)}`,
      SEVERITY_INFO,
    );
    mergeFlags(updated.extra_fields, [audit]);
    // 溯源戳与 _qa_flags 审计解耦：qa_pass 关闭时 marker 被剥，
    // 该字段必须独立存活，否则 critic 自改会洗白成"用户编辑"被金标挖掘回灌。
    insertContentProvenance(updated.extra_fields, llmCriticRevisionProvenance(now()));
    // 修订内容重跑确定性 lint（revise 也可能引入占位符/空字段等问题）
    const relint = lintCard(
      {
        front: updated.front,
        back: updated.back,
        text: updated.text,
        tags: updated.tags,
        extra_fields: updated.extra_fields,
      },
      defaultLintConfig(),
    );
    mergeFlags(updated.extra_fields, relint);
    plan.updates.push(updated);
    plan.revised += 1;
  }
  return plan;
}

/** `extra_fields` 逐键比较（Rust `HashMap` 相等，与键序无关）。 */
function extraFieldsEqual(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  for (const key of leftKeys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

/**
 * `enable_qa_pass=false` 时的落盘收口（与入库前移除 `_qa_flags` 的行为对齐）：
 *
 * - 所有待写回卡片先剥离 `_qa_flags`（flag 留痕、`llm_critic_revised`
 *   审计条目、revise 后 relint 条目一律不落盘）；
 * - **只剥 `QA_FLAGS_FIELD`**：`_content_provenance` 是溯源事实记录而非
 *   QA 留痕，不在剥离范围（门控只关"留痕"，不得关"溯源"，否则 critic
 *   修订会洗白成用户编辑被金标挖掘回灌）；
 * - 剥离后与原卡无内容差异的更新（典型为 flag 裁决）整体丢弃，
 *   避免空写回触发 CAS、递增 local_version 并进入同步链路。差异判定
 *   同时忽略两侧的 `_content_provenance`：溯源戳自身不构成落盘理由。
 *
 * 裁决统计（kept/revised/flagged）不在此改动——critic 观测照常，
 * 只是不产生持久化 QA 留痕。
 */
export function sanitizePlanForDisabledQaPass(plan: CriticPlan, originals: readonly AnkiCard[]): void {
  plan.updates = plan.updates.filter((card) => {
    delete card.extra_fields[QA_FLAGS_FIELD];
    const original = originals.find((candidate) => candidate.id === card.id);
    if (original === undefined) {
      // 原卡不在送审快照中理论上不可达；防御性保留写回交给 CAS 判定
      return true;
    }
    // 对照原卡时同样忽略 _qa_flags：flag-only 更新必须判定为无差异，
    // 不能因原卡带历史留痕而落盘一次"纯留痕删除"写回。
    // _content_provenance 只在比较副本中忽略（不从 card 本体移除）：
    // 有实质内容差异的 revise 写回必须携带溯源戳落盘。
    const cardExtra: Record<string, string> = { ...card.extra_fields };
    delete cardExtra[CONTENT_PROVENANCE_FIELD];
    const originalExtra: Record<string, string> = { ...original.extra_fields };
    delete originalExtra[QA_FLAGS_FIELD];
    delete originalExtra[CONTENT_PROVENANCE_FIELD];
    return (
      card.front !== original.front ||
      card.back !== original.back ||
      card.text !== original.text ||
      card.tags.length !== original.tags.length ||
      card.tags.some((tag, index) => tag !== original.tags[index]) ||
      !extraFieldsEqual(cardExtra, originalExtra)
    );
  });
}

/** 理由拼接：逐条 trim、丢弃空串、以「；」连接；全空时给固定兜底文案。 */
export function joinReasons(reasons: readonly string[]): string {
  const joined = reasons
    .map((reason) => reason.trim())
    .filter((reason) => reason !== '')
    .join('；');
  return joined === '' ? '（模型未给出理由）' : joined;
}

/**
 * 由模型输出（或失败）直接推导落地计划：`Err` → 降级（全 keep，零写入）。
 * 独立成纯函数以便单测降级路径。
 */
export function planFromModelOutput(
  modelOutput: CriticResult<string>,
  cards: readonly AnkiCard[],
  allowedIds: ReadonlySet<string>,
): [CriticPlan, number, string | null] {
  if (!modelOutput.ok) {
    const plan = defaultCriticPlan();
    plan.kept = cards.length;
    return [plan, 0, `模型调用失败: ${modelOutput.error}`];
  }
  const parsed = parseCriticResponse(modelOutput.value, allowedIds);
  if (parsed.ok) {
    return [planUpdates(cards, parsed.value.verdicts), parsed.value.rejected_unknown_ids, null];
  }
  const plan = defaultCriticPlan();
  plan.kept = cards.length;
  return [plan, 0, `裁决解析失败: ${parsed.error}`];
}

// ============================================================================
// 内容溯源（`anki_gold_set.rs` 的 critic 侧入口，实现在 `anki-gold-set.ts`）
// ============================================================================

/** `ContentProvenance::llm_critic_revision()`：critic 自动修订戳。 */
export function llmCriticRevisionProvenance(at: string = nowRfc3339()): ContentProvenance {
  return { actor: PROVENANCE_ACTOR_LLM_CRITIC, code: CRITIC_REVISED_CODE, at };
}

export {
  ORIGINAL_GENERATION_FIELD,
  PROVENANCE_ACTOR_IMPORT,
  PROVENANCE_ACTOR_LLM_CRITIC,
  PROVENANCE_ACTOR_SYNC,
  extractOriginalFromExtras,
  hasCriticRevisionMarker,
  insertContentProvenance,
  isLlmCriticActor,
  parseContentProvenance,
};

// ============================================================================
// 同源金标收集（金标集 → critic 的接线层）
// ============================================================================

/**
 * 金标集挖掘/查询层端口。生产实现是 `anki-gold-set.ts` 的
 * {@link defaultGoldSetMining}；接口保留是为了让评测 harness 可注入。
 */
export interface GoldSetMining {
  goldMiningConfigDefault(): GoldMiningConfig;
  mineGoldSet(candidates: readonly GoldCandidate[], config: GoldMiningConfig): GoldSample[];
  goldLintConfig(): LintConfig;
  selectGroundedReferencePairs(
    samples: readonly GoldSample[],
    lintConfig: LintConfig,
    max: number,
  ): RepairPair[];
}

/** RFC3339 时间戳 → epoch 毫秒；解析失败返回 0（挖掘层的时间戳仅是后备信号）。 */
function timestampMs(rfc3339: string): number {
  const ms = Date.parse(rfc3339);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * 纯函数：从一批同文档卡片行挖掘 grounded 参照对。
 *
 * - `excludeTaskId`：当前收尾任务的卡片剔除——它们刚生成、尚无用户编辑
 *   信号，且正是待评审对象，不能既当裁判参照又当被告；
 * - 带 `_qa_flags.code = llm_critic_revised` 的模型自动修订卡剔除，禁止把
 *   critic 自己的改写伪装成用户金标再回灌；
 * - `_content_provenance` 第二道闸：actor 存在且 ≠ user 的卡直接剔除；
 *   无 provenance 的旧卡放行到挖掘层的"缺编辑者证明"保守闸门；
 * - 金标端过 `selectGroundedReferencePairs` 的 lint 门槛（脏金标不注入）。
 *
 * 无 FSRS 复习信号可用（此路径不 join 复习日志），`review_count` 置 0——
 * 这只影响未编辑正例桶，修正对挖掘不依赖留存信号。
 */
export function goldReferencesFromCards(
  cards: readonly AnkiCard[],
  excludeTaskId: string,
  config: CriticConfig,
  goldSet: GoldSetMining,
): ReferenceCard[] {
  const candidates: GoldCandidate[] = [];
  for (const card of cards) {
    if (card.task_id === excludeTaskId || card.is_error_card) continue;
    if (hasCriticRevisionMarker(card.extra_fields)) continue;
    const provenance = parseContentProvenance(card.extra_fields);
    // provenance 过滤：有 actor 且非 user → 剔除；无 provenance 放行，
    // 由挖掘层的编辑者闸门保守兜底。
    if (provenance !== null && provenance.actor !== PROVENANCE_ACTOR_USER) continue;
    const original = extractOriginalFromExtras(card.extra_fields);
    if (original === null) continue;
    candidates.push({
      card_id: card.id,
      current: { front: card.front, back: card.back, text: card.text },
      original,
      created_at_ms: timestampMs(card.created_at),
      updated_at_ms: timestampMs(card.updated_at),
      deleted_at_ms: null,
      review_count: 0,
      again_count: 0,
      was_error_card: false,
      is_error_card: card.is_error_card,
      // 按 marker/provenance 真值计算（不硬编码 false）：即便上方 filter 顺序
      // 被改动，挖掘侧第 1 通道仍是第二道防线。
      critic_revised: hasCriticRevisionMarker(card.extra_fields) || isLlmCriticActor(card.extra_fields),
      edit_actor: provenance === null ? null : provenance.actor,
    });
  }
  if (candidates.length === 0) return [];

  const samples = goldSet.mineGoldSet(candidates, goldSet.goldMiningConfigDefault());
  return goldSet
    .selectGroundedReferencePairs(samples, goldSet.goldLintConfig(), config.max_reference_pairs)
    .map((pair) => referenceCardFromRepairPair(pair));
}

/**
 * 生产收尾路径的金标收集入口：查同文档全部卡片行，挖同源修正对。
 * **任何失败（DB 错误等）都退化为空列表**——critic 回到规则 rubric，
 * 收集层绝不拖垮制卡收尾（与 critic 本体的降级哲学一致）。
 */
export function collectGoldReferences(
  store: Pick<CriticCardStore, 'getCardsForDocument'>,
  task: DocumentTask,
  config: CriticConfig,
  goldSet: GoldSetMining,
  logger: CriticLogger = defaultCriticLogger,
): ReferenceCard[] {
  let cards: AnkiCard[];
  try {
    cards = store.getCardsForDocument(task.document_id);
  } catch (error) {
    logger.warn(`[ANKI_CRITIC] 收集同源金标失败（退回规则 rubric）: ${errorText(error)}`);
    return [];
  }
  const references = goldReferencesFromCards(cards, task.id, config, goldSet);
  if (references.length > 0) {
    logger.info(
      `[ANKI_CRITIC] 任务 ${task.id} 挖得 ${references.length} 对同源金标参照（文档 ${task.document_id}）`,
    );
  }
  return references;
}

// ============================================================================
// 编排器（任务收尾调用；永不向上抛错）
// ============================================================================

/** 日志端口（`tracing::info` / `tracing::warn`）。 */
export interface CriticLogger {
  info(message: string): void;
  warn(message: string): void;
}

/** 默认日志端口：插件入口通过 {@link configureCriticLogger} 注入 `ctx.logger`。 */
let configuredCriticLogger: CriticLogger = { info() {}, warn() {} };

/** 插件入口在加载时调用：把 critic 的 `tracing` 日志接到宿主日志。 */
export function configureCriticLogger(logger: CriticLogger): void {
  configuredCriticLogger = logger;
}

export const defaultCriticLogger: CriticLogger = {
  info(message) {
    configuredCriticLogger.info(message);
  },
  warn(message) {
    configuredCriticLogger.warn(message);
  },
};

/** `AnkiLibraryScope`：库 CAS 写入的调用方作用域（Rust 侧只有 `agent()`）。 */
export type AnkiLibraryScope = 'agent';

/** `dstu-storage/database/mod.rs:112-116`：库卡片记录（critic 只读更新时间）。 */
export interface AnkiLibraryCardRecord {
  library_card: { card: AnkiCard };
}

/** `dstu-storage/database/mod.rs:142-146`：CAS 版本更新结果。 */
export type AnkiLibraryCardVersionUpdate =
  | { type: 'updated'; current: AnkiLibraryCardRecord }
  | { type: 'conflict'; current: AnkiLibraryCardRecord }
  | { type: 'notFound' };

/**
 * critic 需要的数据库端口（`Database` 的四条读/写路径）。
 * 方法抛出异常等价于 Rust 的 `Err`。
 */
export interface CriticCardStore {
  getCardsForTask(taskId: string): AnkiCard[];
  getCardsForDocument(documentId: string): AnkiCard[];
  /**
   * 按送审快照的 `updated_at` 做 CAS 写回；成功时会递增 `local_version`，
   * 保证 critic 改动进入同步链路。
   */
  updateAnkiCardIfVersionForLibrary(
    scope: AnkiLibraryScope,
    card: AnkiCard,
    expectedUpdatedAt: string,
  ): AnkiLibraryCardVersionUpdate;
}

/** `LLMManager` 的 critic 相关端口。 */
export interface AnkiCriticLlm {
  /** 经 Sidekick 分层路由解析 Critic 角色决策；路由不可用返回 null。 */
  resolveAnkiRoleDecision(role: AnkiModelRole, mode: RoutingMode): Promise<RoleDecision | null>;
  /** `call_anki_routed_raw_prompt`（model2_pipeline.rs:8632）；critic 不带图片，`images` 恒为 null。 */
  callAnkiRoutedRawPrompt(
    decision: RoleDecision | null,
    task: string,
    prompt: string,
    images: null,
  ): Promise<{ assistant_message: string }>;
}

/** 编排器依赖（数据库 / 模型 / 金标挖掘三路端口 + 日志）。 */
export interface CriticDeps {
  db: CriticCardStore;
  llm: AnkiCriticLlm;
  goldSet: GoldSetMining;
  logger?: CriticLogger;
}

/** Rust `e.to_string()`；llmRawPrompt 拒绝的是 AppError 值（Display 即 message），不是 Error 实例。 */
function errorText(error: unknown): string {
  if (isAppErrorValue(error)) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/** `{:?}` 的 Rust Debug 形态（Option 的 `Some(..)` / `None`）。 */
function rustDebugOption(value: string | boolean | null): string {
  if (value === null) return 'None';
  if (typeof value === 'boolean') return `Some(${value ? 'true' : 'false'})`;
  return `Some(${JSON.stringify(value)})`;
}

/** 单轮模型调用（最多修订轮 1，见 `effectiveRevisionRounds` 钳位）。 */
async function callCriticModel(
  llm: AnkiCriticLlm,
  decision: RoleDecision | null,
  promptText: string,
): Promise<CriticResult<string>> {
  const TIMED_OUT = 'critic-model-timeout';
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), CRITIC_MODEL_TIMEOUT_SECS * 1000);
  });
  const call = llm
    .callAnkiRoutedRawPrompt(decision, 'anki_critic.run_critic_pass', promptText, null)
    .then((output): CriticResult<string> => ({ ok: true, value: output.assistant_message }))
    .catch((error: unknown): CriticResult<string> => ({ ok: false, error: errorText(error) }));
  try {
    const result = await Promise.race([call, timeout]);
    if (result === TIMED_OUT) {
      return { ok: false, error: `超过 ${CRITIC_MODEL_TIMEOUT_SECS} 秒未返回` };
    }
    return result;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * 任务收尾后的批量 critic pass。**永不抛错**：任何失败（模型/解析/DB）
 * 都折叠为 `CriticSummary`（`degraded` / `persist_failures`），
 * 保证 critic 不影响整批制卡结果。
 *
 * `references`：grounded 同源金标参照（0-N 对）。生产收尾路径由
 * `collectGoldReferences` 挖掘；评测 harness 可直接注入。
 */
export async function runCriticPass(
  deps: CriticDeps,
  task: DocumentTask,
  references: readonly ReferenceCard[],
  config: CriticConfig,
): Promise<CriticSummary> {
  const logger = deps.logger ?? defaultCriticLogger;
  const summary = defaultCriticSummary();

  if (effectiveRevisionRounds(config) === 0) {
    summary.degraded = '修订轮数为 0，critic 空转';
    return summary;
  }

  // 只评审本任务成功入库的非错误卡
  let cards: AnkiCard[];
  try {
    cards = deps.db.getCardsForTask(task.id).filter((card) => !card.is_error_card);
  } catch (error) {
    summary.degraded = `读取任务卡片失败: ${errorText(error)}`;
    return summary;
  }
  if (cards.length === 0) {
    // 空列表：无事可做，静默成功（不算降级）
    return summary;
  }

  const prompt = buildCriticPrompt(task.content_segment, cards, references, config);
  summary.skipped_over_budget = prompt.skipped_over_budget;
  summary.gold_references = prompt.included_references;
  summary.gold_references_truncated = prompt.skipped_references;
  const allowedIds = new Set(prompt.included_ids);
  const examined = cards.filter((card) => allowedIds.has(card.id));
  summary.examined = examined.length;
  if (examined.length === 0) {
    summary.degraded = '预算内无可评审卡片';
    return summary;
  }

  // 终审属 Critic 角色（低频、高价值）——经 Sidekick 模型分层路由取主模型槽
  // （缺槽位降级到制卡槽同一模型）。决策写入摘要可观测；路由不可用
  // （decision=null）时 callAnkiRoutedRawPrompt 自动回退旧路径。
  const routingMode = parseRoutingMode(task.anki_generation_options_json);
  const criticDecision = await deps.llm.resolveAnkiRoleDecision('critic', routingMode);
  noteRoutingDecision(summary, criticDecision);

  const modelOutput = await callCriticModel(deps.llm, criticDecision, prompt.text);

  const [plan, rejectedUnknownIds, degraded] = planFromModelOutput(modelOutput, examined, allowedIds);
  summary.kept = plan.kept;
  summary.revised = plan.revised;
  summary.flagged = plan.flagged;
  summary.rejected_unknown_ids = rejectedUnknownIds;
  summary.degraded = degraded;

  // enable_qa_pass=false（公开契约"不要 QA 留痕"）：裁决与统计照常，
  // 但 flag 留痕 / revise 审计 / relint 的 _qa_flags 一律不落盘。
  const qaPass = qaPassEnabled(structuredOutputOptionsFromOptionsJson(task.anki_generation_options_json));
  if (!qaPass) {
    sanitizePlanForDisabledQaPass(plan, examined);
  }

  // 持久化：模型调用最长可达 180 秒，送审后用户可能已经编辑同一卡片。
  // 必须用送审快照的 updated_at 做 CAS，绝不能用无版本 UPDATE 覆盖用户新内容。
  for (const card of plan.updates) {
    try {
      const outcome = deps.db.updateAnkiCardIfVersionForLibrary('agent', card, card.updated_at);
      if (outcome.type === 'conflict') {
        logger.warn(
          `[ANKI_CRITIC] 卡片 ${card.id} 在送审后已被修改（当前版本 ${outcome.current.library_card.card.updated_at}），跳过以避免覆盖用户编辑`,
        );
        summary.persist_failures += 1;
      } else if (outcome.type === 'notFound') {
        logger.warn(`[ANKI_CRITIC] 卡片 ${card.id} 在写回前已不存在，跳过`);
        summary.persist_failures += 1;
      }
    } catch (error) {
      logger.warn(`[ANKI_CRITIC] 卡片 ${card.id} 更新失败: ${errorText(error)}`);
      summary.persist_failures += 1;
    }
  }

  logger.info(
    `[ANKI_CRITIC] 任务 ${task.id} critic 完成: routed_model=${rustDebugOption(summary.routed_model)} routed_degraded=${rustDebugOption(summary.routed_degraded)} examined=${summary.examined} kept=${summary.kept} revised=${summary.revised} flagged=${summary.flagged} rejected_ids=${summary.rejected_unknown_ids} skipped=${summary.skipped_over_budget} gold_refs=${summary.gold_references} gold_refs_truncated=${summary.gold_references_truncated} persist_failures=${summary.persist_failures} degraded=${rustDebugOption(summary.degraded)}`,
  );
  return summary;
}

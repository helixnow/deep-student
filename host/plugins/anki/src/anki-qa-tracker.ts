/**
 * 规则 9/9b：文档级重复/近重复指纹与 registry（`anki_qa_lint.rs:618-815`）。
 */
import { LintIssue } from './anki-qa-types.ts';
import { formatFixed0, normalizeForCompare } from './anki-qa-text.ts';

// ============================================================================
// 规则 9/9b：文档级重复卡指纹 + 近重复检测
// ============================================================================

/**
 * 近重复判定默认阈值：归一化字符 bigram 集合的 Jaccard 相似度 ≥ 0.82 视为近重复。
 *
 * 取值依据：小编辑（增删两三个字、加语气词）后的问句相似度普遍落在 0.85+；
 * 而问同类不同对象的卡（"什么是TCP" vs "什么是UDP"）在 0.3 以下，
 * 0.82 在两簇之间留有余量。
 */
export const DEFAULT_NEAR_DUPLICATE_THRESHOLD = 0.82;

/**
 * 近重复扫描登记的指纹上限：超过后新卡不再加入 bigram 索引
 * （精确重复检测不受影响），把单卡近重复检测成本封顶在
 * O(max_near_tracked × 平均 bigram 数)，防止超大文档退化为 O(n²) 长尾。
 */
export const DEFAULT_MAX_NEAR_TRACKED = 2048;

/** 单次指纹观察的结果。 */
export interface FingerprintObservation {
  /** 归一化指纹与同文档已登记卡完全相同。 */
  exact_duplicate: boolean;
  /**
   * 非精确重复但与某张已登记卡的 bigram Jaccard 相似度达到阈值时为
   * 该最高相似度；精确重复时恒为 null（不重复报告）。
   */
  near_duplicate: number | null;
}

/** 全 false 的观察结果（Rust `FingerprintObservation::default()`）。 */
export function emptyFingerprintObservation(): FingerprintObservation {
  return { exact_duplicate: false, near_duplicate: null };
}

/**
 * 同文档归一化 front 指纹去重器 + 近重复检测器。每个文档持有一个实例
 * （显式持有或经 `documentTracker` registry 跨 segment task 共享）。
 *
 * 指纹 = front（或 cloze Text）经 `normalizeForCompare` 后的字符串。
 * 归一化会剥离 HTML 标签、折叠空白、去标点、转小写，
 * 因此 "什么是TCP？" 与 "<b>什么是 tcp</b>" 视为同一张卡。
 *
 * 近重复 = 归一化指纹的字符 bigram 集合与任一已登记指纹的 Jaccard
 * 相似度 ≥ 阈值。字符 bigram 对中文（无空格分词）与英文同样适用。
 */
export class FingerprintTracker {
  private readonly seen = new Set<string>();
  /** 已登记指纹的 bigram 集合（近重复扫描索引，长度受 max_near_tracked 封顶）。 */
  private readonly shingleSets: Set<string>[] = [];
  private near_duplicate_threshold: number;
  /**
   * `max_near_tracked`，测试会直接改小以验证封顶行为
   * （Rust 侧为同模块私有字段，测试模块可直接赋值）。
   */
  max_near_tracked: number = DEFAULT_MAX_NEAR_TRACKED;

  constructor() {
    this.near_duplicate_threshold = DEFAULT_NEAR_DUPLICATE_THRESHOLD;
  }

  /** 自定义近重复阈值（clamp 到 (0, 1]；1.0 等价于只做精确重复检测）。 */
  static withNearDuplicateThreshold(threshold: number): FingerprintTracker {
    const tracker = new FingerprintTracker();
    tracker.near_duplicate_threshold = clamp(threshold, Number.EPSILON, 1.0);
    return tracker;
  }

  /**
   * 观察一张卡的指纹 key（front 或 cloze Text）：
   * 返回精确重复/近重复判定，并把新指纹登记进索引。
   *
   * - 空白/空指纹永远返回全 false（空卡由 empty_front 规则处理，不算重复）；
   * - 精确重复不重复登记（首次登记时 bigram 已入索引）；
   * - 近重复卡照常登记（后续与它相似的卡也应被 flag）。
   */
  observe(keySource: string): FingerprintObservation {
    const fp = normalizeForCompare(keySource);
    if (fp === '') {
      return emptyFingerprintObservation();
    }
    if (this.seen.has(fp)) {
      return { exact_duplicate: true, near_duplicate: null };
    }
    this.seen.add(fp);

    const shingles = charBigrams(fp);
    let bestSimilarity = 0;
    for (const prev of this.shingleSets) {
      const similarity = jaccard(shingles, prev);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
      }
    }
    if (this.shingleSets.length < this.max_near_tracked) {
      this.shingleSets.push(shingles);
    }

    return {
      exact_duplicate: false,
      near_duplicate: bestSimilarity >= this.near_duplicate_threshold ? bestSimilarity : null,
    };
  }

  /**
   * 登记指纹；若之前已见过相同指纹则返回 true（= 精确重复）。
   * 兼容旧调用方的薄封装，内部走 `observe`。
   */
  checkAndInsert(front: string): boolean {
    return this.observe(front).exact_duplicate;
  }

  len(): number {
    return this.seen.size;
  }

  isEmpty(): boolean {
    return this.seen.size === 0;
  }
}

/** `f64::clamp` 语义：NaN 传入时结果仍为 NaN（JS `Math.min/max` 同样传播 NaN）。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 归一化指纹的字符 bigram 集合；不足 2 字符时以整串为单一 shingle，
 * 避免单字卡产生空集合（空集合 Jaccard 恒 0，会漏检单字重复的近邻）。
 */
function charBigrams(fp: string): Set<string> {
  const chars = [...fp];
  if (chars.length < 2) {
    return new Set([fp]);
  }
  const out = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i += 1) {
    out.add(`${chars[i] ?? ''}${chars[i + 1] ?? ''}`);
  }
  return out;
}

/** 两个 shingle 集合的 Jaccard 相似度（|A∩B| / |A∪B|）。空集合恒 0。 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return intersection / union;
}

// ============================================================================
// 文档级 tracker registry（生产路径：跨 segment task 共享指纹状态）
// ============================================================================

/**
 * 进程级文档 tracker 注册表。key = documentId。
 *
 * 同一文档的所有 segment task 并发生成时经此共享同一个 tracker，暂停/恢复与
 * 统一重试任务也命中同一实例。文档完成/取消/删除时由调度层调用
 * `releaseDocumentTracker` 释放。
 */
const DOCUMENT_TRACKERS = new Map<string, FingerprintTracker>();

/** 取（或懒创建）documentId 对应的共享 tracker。 */
export function documentTracker(documentId: string): FingerprintTracker {
  const existing = DOCUMENT_TRACKERS.get(documentId);
  if (existing !== undefined) return existing;
  const created = new FingerprintTracker();
  DOCUMENT_TRACKERS.set(documentId, created);
  return created;
}

/** 释放 documentId 对应的 tracker（文档完成/取消/删除时调用，防泄漏）。 */
export function releaseDocumentTracker(documentId: string): void {
  DOCUMENT_TRACKERS.delete(documentId);
}

/**
 * 生产路径入口：对一张卡的指纹 key 做文档级重复/近重复检测，
 * 返回应打的 lint flag 列表（空 = 干净）。
 *
 * 失败隔离保证：本函数**永不抛错**，documentId 或 key 为空白时为 no-op。
 * 检测失败最坏结果是少打 flag，调用方无需任何错误处理，卡片入库路径完全不受影响。
 */
export function observeDocumentCard(documentId: string, keySource: string): LintIssue[] {
  if (documentId.trim() === '' || keySource.trim() === '') {
    return [];
  }
  const tracker = documentTracker(documentId);
  const observation = tracker.observe(keySource);
  return issuesFromObservation(observation);
}

/**
 * 把指纹观察结果转换为结构化 lint 违规。
 *
 * - 精确重复 → `duplicate_in_document`（warn，不丢卡）；
 * - 近重复 → `near_duplicate`（warn，不丢卡），message 携带相似度百分比。
 *
 * 精确重复时不再叠加 near_duplicate（相似度恒为 1.0，属重复信息）。
 */
export function issuesFromObservation(observation: FingerprintObservation): LintIssue[] {
  const issues: LintIssue[] = [];
  if (observation.exact_duplicate) {
    issues.push(
      LintIssue.new(
        'duplicate_in_document',
        'card',
        '同文档内已存在归一化 front 相同的卡片',
        'warn',
      ),
    );
  } else if (observation.near_duplicate !== null) {
    issues.push(
      LintIssue.new(
        'near_duplicate',
        'card',
        `与同文档已有卡片高度相似（字符 bigram Jaccard ${formatFixed0(observation.near_duplicate * 100)}%），疑似近重复`,
        'warn',
      ),
    );
  }
  return issues;
}


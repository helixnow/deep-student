/**
 * Chat V2 — 用户消息展示级密钥/令牌脱敏
 *
 * 借鉴 DeepSeek Harness 0.2.1：对「已发送的用户消息」做默认脱敏展示，
 * 命中常见密钥/令牌时以 `••••` 遮蔽，用户可点击「显示原文」临时查看。
 *
 * 边界（刻意保持最小改动面）：
 * - 只处理展示层，不修改 store / 数据库 / 实际发送内容（复制消息仍取原文）；
 * - 只对用户消息启用（assistant 消息不处理，调用方按角色短路）；
 * - 纯函数、无副作用，便于单测与复用。
 *
 * 安全/性能约束：
 * - 所有正则为线性扫描的字符类 + 固定/简单量词，没有嵌套量词，不存在灾难性回溯；
 * - 匹配需明确前缀或 `key=value` 语义，宁可漏匹配也不误伤普通中文/URL 正文；
 * - 重叠命中按「起点优先、同起点更长优先」贪心去重，保证每个字符只被遮蔽一次。
 */

// ============================================================================
// 类型
// ============================================================================

/** 命中的敏感串类别（用于测试/调试，展示层不依赖） */
export type SecretKind =
  | 'openai' // sk-...（DeepSeek / OpenAI / Anthropic 风格）
  | 'bearer' // Authorization: Bearer ...
  | 'github_pat' // ghp_... / github_pat_...
  | 'aws_access_key' // AKIA...
  | 'slack' // xox[baprs]-...
  | 'google_api_key' // AIza...
  | 'huggingface' // hf_...
  | 'assignment'; // api_key=... / token: "..." / password=...

/** 单个命中片段（原文下标区间为 [start, end)） */
export interface SecretMatch {
  kind: SecretKind;
  /** 在原文中的起始下标（含） */
  start: number;
  /** 在原文中的结束下标（不含） */
  end: number;
  /** 脱敏后的展示文本（保留可识别前缀 + `••••`） */
  masked: string;
}

/** `maskSecrets` 的返回值 */
export interface SecretMaskResult {
  /** 脱敏后的文本；无命中时原样返回 */
  masked: string;
  /** 命中数量 */
  count: number;
}

// ============================================================================
// 规则
// ============================================================================

/** 统一遮蔽符：不泄漏原始长度/内容 */
const MASK = '••••';

/** 最短可能命中的敏感串长度（`token=` 6 + 12 位值 = 18），更短的文本直接短路 */
const MIN_SECRET_LENGTH = 18;

interface SecretRule {
  kind: SecretKind;
  /** 全局正则（供 matchAll 使用；不可复用 lastIndex 状态） */
  pattern: RegExp;
  /** 命中文本中需要保留的可识别前缀（含最多 2 个字符），缺省表示由 assignment 逻辑处理 */
  keepPrefix?: RegExp;
}

/**
 * 检测规则表。
 *
 * 注意：`pattern` 必须以 `g` 结尾（`String.prototype.matchAll` 要求），
 * 且不能包含会有歧义的嵌套量词 —— 所有规则都是单遍线性扫描。
 */
const RULES: readonly SecretRule[] = [
  // DeepSeek / OpenAI 风格 sk-...（也覆盖 sk-ant-... / sk-proj-...）
  {
    kind: 'openai',
    pattern: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/g,
    keepPrefix: /^sk-[A-Za-z0-9_-]{0,2}/,
  },
  // HTTP Authorization: Bearer <token>
  {
    kind: 'bearer',
    pattern: /(?<![A-Za-z0-9_-])Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
    keepPrefix: /^Bearer\s+[A-Za-z0-9._~+/=-]{0,2}/,
  },
  // GitHub classic personal access token
  {
    kind: 'github_pat',
    pattern: /(?<![A-Za-z0-9_])ghp_[A-Za-z0-9]{20,}/g,
    keepPrefix: /^(?:ghp_|github_pat_)[A-Za-z0-9_]{0,2}/,
  },
  // GitHub fine-grained personal access token
  {
    kind: 'github_pat',
    pattern: /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,}/g,
    keepPrefix: /^(?:ghp_|github_pat_)[A-Za-z0-9_]{0,2}/,
  },
  // AWS access key id（AKIA + 16 位大写字母/数字）
  {
    kind: 'aws_access_key',
    pattern: /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}/g,
    keepPrefix: /^AKIA[0-9A-Z]{0,2}/,
  },
  // Slack token
  {
    kind: 'slack',
    pattern: /(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{10,}/g,
    keepPrefix: /^xox[baprs]-[A-Za-z0-9-]{0,2}/,
  },
  // Google API key（AIza + 35 位）
  {
    kind: 'google_api_key',
    pattern: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/g,
    keepPrefix: /^AIza[0-9A-Za-z_-]{0,2}/,
  },
  // Hugging Face token
  {
    kind: 'huggingface',
    pattern: /(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{20,}/g,
    keepPrefix: /^hf_[A-Za-z0-9]{0,2}/,
  },
  // 通用赋值式：api_key=... / token: "..." / password = ...（忽略大小写）
  // 值要求 ≥ 12 位「类 token 字符」，避免把普通短语/中文误判为密钥。
  {
    kind: 'assignment',
    pattern:
      /(?<![A-Za-z0-9_])(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}/gi,
  },
];

// ============================================================================
// 脱敏格式
// ============================================================================

interface FormattedMatch {
  end: number;
  masked: string;
}

/**
 * 保留可识别前缀（如 `sk-ab` / `ghp_ab` / `Bearer ey`），其余统一 `••••`。
 * 不保留原文长度，也不保留原始尾段。
 */
function formatKnownPrefix(
  rule: SecretRule,
  text: string,
  start: number,
  end: number,
): FormattedMatch | null {
  if (!rule.keepPrefix) return null;
  const raw = text.slice(start, end);
  const prefix = rule.keepPrefix.exec(raw);
  if (!prefix) return null;
  return { end, masked: prefix[0] + MASK };
}

/**
 * 通用赋值式：保留 `api_key = "` 这类标签/分隔符，只遮蔽值；
 * 若值后面紧跟成对引号，一并保留成 `api_key = "••••"`。
 */
function formatAssignment(text: string, start: number, end: number): FormattedMatch | null {
  const raw = text.slice(start, end);
  const label = /^[^:=]*[:=]\s*["']?/.exec(raw);
  if (!label) return null;

  let nextEnd = end;
  let masked = label[0] + MASK;
  const closing = text[nextEnd];
  if ((closing === '"' || closing === "'") && label[0].endsWith(closing)) {
    masked += closing;
    nextEnd += 1;
  }
  return { end: nextEnd, masked };
}

// ============================================================================
// 导出 API
// ============================================================================

/**
 * 找出文本中所有需要脱敏的片段（按原文顺序、互不重叠）。
 *
 * @param text 原文
 * @returns 命中列表；无命中返回空数组
 */
export function findSecrets(text: string): SecretMatch[] {
  if (typeof text !== 'string' || text.length < MIN_SECRET_LENGTH) return [];

  interface Candidate {
    rule: SecretRule;
    start: number;
    end: number;
  }

  const candidates: Candidate[] = [];
  for (const rule of RULES) {
    // matchAll 会克隆正则，不会污染模块级 pattern 的 lastIndex
    for (const match of text.matchAll(rule.pattern)) {
      const start = match.index;
      if (start === undefined) continue;
      candidates.push({ rule, start, end: start + match[0].length });
    }
  }
  if (candidates.length === 0) return [];

  // 起点优先；同起点时更长匹配优先（例如整段 `api_key=sk-...` 优于内部 `sk-...`）
  candidates.sort((a, b) => a.start - b.start || b.end - a.end);

  const matches: SecretMatch[] = [];
  let lastEnd = -1;
  for (const candidate of candidates) {
    if (candidate.start < lastEnd) continue; // 与已选片段重叠，跳过
    const formatted =
      candidate.rule.kind === 'assignment'
        ? formatAssignment(text, candidate.start, candidate.end)
        : formatKnownPrefix(candidate.rule, text, candidate.start, candidate.end);
    if (!formatted) continue;
    matches.push({
      kind: candidate.rule.kind,
      start: candidate.start,
      end: formatted.end,
      masked: formatted.masked,
    });
    lastEnd = formatted.end;
  }
  return matches;
}

/**
 * 脱敏文本：命中片段替换为「可识别前缀 + ••••」，其余内容原样保留。
 *
 * 幂等：对返回的 `masked` 再次调用时 count 为 0、内容不变。
 */
export function maskSecrets(text: string): SecretMaskResult {
  const matches = findSecrets(text);
  if (matches.length === 0) return { masked: text, count: 0 };

  const parts: string[] = [];
  let cursor = 0;
  for (const match of matches) {
    parts.push(text.slice(cursor, match.start), match.masked);
    cursor = match.end;
  }
  parts.push(text.slice(cursor));

  return { masked: parts.join(''), count: matches.length };
}

/** 文本是否包含需要脱敏的敏感串 */
export function hasSecrets(text: string): boolean {
  return findSecrets(text).length > 0;
}

/**
 * 是否对该角色的消息内容启用展示级脱敏。
 *
 * 仅用户消息、且确实命中敏感串时返回 true；assistant 消息不做任何检测，
 * 调用方可据此零开销地短路回原文渲染路径。
 */
export function shouldMaskUserContent(
  role: string | null | undefined,
  text: string | null | undefined,
): boolean {
  return role === 'user' && typeof text === 'string' && hasSecrets(text);
}

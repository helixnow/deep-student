/**
 * DSTU 命名工具
 *
 * 提供资源命名相关的工具函数，支持自动去重和唯一名称生成。
 *
 * 约束：
 * 1. 使用锁机制防止并发命名冲突
 * 2. 遵循操作系统文件命名规则（Windows/macOS 风格）
 * 3. 支持解析和生成带序号的名称
 */

// ── 类型定义 ──

/**
 * 解析名称结果
 */
export interface ParsedNameWithNumber {
  /** 基础名称（不含序号） */
  baseName: string;
  /** 序号（如果没有则为 null） */
  number: number | null;
}

// ── 名称解析 ──

/**
 * 从名称中提取基础名和序号
 *
 * 解析规则：
 * - "新题目集" → { baseName: "新题目集", number: null }
 * - "新题目集 2" → { baseName: "新题目集", number: 2 }
 * - "新题目集 10" → { baseName: "新题目集", number: 10 }
 * - "My Document 3" → { baseName: "My Document", number: 3 }
 *
 * @param name 完整名称
 * @returns 基础名和序号（如果没有序号则为 null）
 */
export function parseNameWithNumber(name: string): ParsedNameWithNumber {
  // 匹配末尾的空格+数字
  const match = name.match(/^(.+?)\s+(\d+)$/);
  if (match) {
    return {
      baseName: match[1],
      number: parseInt(match[2], 10),
    };
  }
  return { baseName: name, number: null };
}

// ── 名称生成 ──

/**
 * 生成唯一名称
 *
 * 模拟 Windows/macOS 的文件命名规则：
 * - 第一个文件：新题目集
 * - 第二个文件：新题目集 2
 * - 第三个文件：新题目集 3
 *
 * @param baseName 基础名称（如 "新题目集"）
 * @param existingNames 已存在的名称列表
 * @returns 唯一名称
 *
 * @example
 * ```typescript
 * generateUniqueName("新题目集", ["新题目集", "新题目集 2"]) // → "新题目集 3"
 * generateUniqueName("新题目集", []) // → "新题目集"
 * generateUniqueName("My Doc", ["My Doc", "Other"]) // → "My Doc 2"
 * ```
 */
export function generateUniqueName(baseName: string, existingNames: string[]): string {
  // 如果基础名称不存在于现有列表中，直接返回
  if (!existingNames.includes(baseName)) {
    return baseName;
  }

  // 收集所有匹配基础名称的序号
  const usedNumbers = new Set<number>();
  usedNumbers.add(1); // 基础名称视为占用序号 1

  for (const name of existingNames) {
    const parsed = parseNameWithNumber(name);
    if (parsed.baseName === baseName && parsed.number !== null) {
      usedNumbers.add(parsed.number);
    }
  }

  // 找到最小的未使用序号（从 2 开始）
  let nextNumber = 2;
  while (usedNumbers.has(nextNumber)) {
    nextNumber++;
  }

  return `${baseName} ${nextNumber}`;
}

// ── 并发安全的名称生成 ──

/**
 * 名称生成锁（防止并发冲突）
 */
const namingLocks = new Map<string, Promise<void>>();

/**
 * 获取命名锁的 key
 */
function getLockKey(baseName: string, scope?: string): string {
  return scope ? `${scope}:${baseName}` : baseName;
}

/**
 * 并发安全的唯一名称生成
 *
 * 使用锁机制防止并发创建时的命名冲突。
 *
 * @param baseName 基础名称
 * @param fetchExistingNames 获取现有名称列表的函数（异步）
 * @param scope 锁作用域（可选，用于区分不同上下文的锁）
 * @returns 唯一名称
 *
 * @example
 * ```typescript
 * const name = await generateUniqueNameSafe(
 *   "新题目集",
 *   async () => {
 *     const nodes = await dstu.list('/', { typeFilter: 'exam' });
 *     return nodes.map(n => n.name);
 *   },
 *   'exam' // scope
 * );
 * ```
 */
export async function generateUniqueNameSafe(
  baseName: string,
  fetchExistingNames: () => Promise<string[]>,
  scope?: string
): Promise<string> {
  const lockKey = getLockKey(baseName, scope);

  // 等待之前的锁释放
  const existingLock = namingLocks.get(lockKey);
  if (existingLock) {
    await existingLock;
  }

  // 创建新锁
  let releaseLock: () => void;
  const lockPromise = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  namingLocks.set(lockKey, lockPromise);

  try {
    // 获取现有名称列表
    const existingNames = await fetchExistingNames();

    // 生成唯一名称
    const uniqueName = generateUniqueName(baseName, existingNames);

    return uniqueName;
  } finally {
    // 释放锁
    namingLocks.delete(lockKey);
    releaseLock!();
  }
}

// ── 工具函数 ──

/**
 * 检查名称是否有效
 *
 * @param name 名称
 * @returns 是否有效
 */
export function isValidName(name: string): boolean {
  if (!name || name.trim() !== name) {
    return false; // 不允许空名称或前后有空格
  }

  // 不允许特殊字符（根据需要扩展）
  const invalidChars = /[<>:"|?*\\/]/;
  if (invalidChars.test(name)) {
    return false;
  }

  return true;
}

/**
 * 清理名称（移除非法字符）
 *
 * @param name 原始名称
 * @returns 清理后的名称
 */
export function sanitizeName(name: string): string {
  return name
    .trim()
    .replace(/[<>:"|?*\\/]/g, '_'); // 替换非法字符为下划线
}

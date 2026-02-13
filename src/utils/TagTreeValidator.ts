/**
 * TagTreeValidator
 * -----------------
 * 解析 Markdown 格式的标签树并输出：
 * 1. totalTags     总标签数量
 * 2. maxDepth      0-based 最大数据库层级（根=0，对应 Markdown # 数量 - 1）
 * 3. hardErrors    阻止导入的硬性错误列表
 * 4. warnings      可忽略的软性提醒列表
 *
 * 规则 (与后端保持一致)：
 *   Markdown “#” 层级 → 数据库层级 = (# 数量 - 1)
 *   最大允许层级 <= 5
 *   标签名称不能为空
 */
export interface ValidationResult {
  totalTags: number;
  maxDepth: number;
  hardErrors: string[];
  warnings: string[];
}

/**
 * 将 Markdown 内容解析并验证
 * @param content Markdown 文本
 */
export function validateMarkdownTagTree(content: string): ValidationResult {
  const lines = content.split(/\r?\n/);

  let totalTags = 0;
  let maxDepth = 0;
  let rootCount = 0;
  const hardErrors: string[] = [];
  const warnings: string[] = [];

  lines.forEach((rawLine, idx) => {
    const line = rawLine.trim();
    if (!line.startsWith('#')) return;

    // 统计 # 数量
    const hashCount = line.match(/^#+/)![0].length;
    const dbLevel = hashCount - 1; // 数据库层级
    const name = line.slice(hashCount).trim();

    // 空名称
    if (!name) {
      hardErrors.push(`第 ${idx + 1} 行：标签名称为空`);
      return;
    }

    if (dbLevel > 5) {
      hardErrors.push(`第 ${idx + 1} 行：标题级别（#数量=${hashCount}）超过最大允许 6`);
      return;
    }

    totalTags += 1;
    if (hashCount === 1) {
      rootCount += 1;
    }
    if (dbLevel > maxDepth) maxDepth = dbLevel;
  });

  if (rootCount === 0) {
    hardErrors.push('必须包含一个以单个 # 开头的根标签（示例：# 学科总纲）');
  } else if (rootCount > 1) {
    hardErrors.push(`检测到 ${rootCount} 行以单个 # 开头的根标签，要求只能有 1 行`);
  }

  // 软性提醒
  // 建议标签树层级保持在 5 - 6；若 ≤4 则给出提示
  if (maxDepth <= 4) {
    warnings.push('当前最大层级较浅，建议使用 5 - 6 层以获得更好的结构清晰度');
  }
  // 建议标签总数保持在 50 - 150 之间
  if (totalTags <= 50) {
    hardErrors.push(`标签总数仅 ${totalTags}，必须大于 50 才能导入`);
  }
  if (totalTags >= 500) {
    hardErrors.push(`标签总数为 ${totalTags}，必须小于 500 才能导入`);
  }
  if (totalTags > 150 && totalTags < 500) {
    warnings.push(`标签总数为 ${totalTags}，建议控制在 50 - 150 之间以获得最佳体验`);
  }

  return { totalTags, maxDepth, hardErrors, warnings };
}

/**
 * 节点内联样式小工具（RootNode / BranchNode 共用）
 */

import type React from 'react';

/**
 * 剔除值为 undefined 的键。
 *
 * `{ ...theme, ...custom }` 时 custom 里显式的 undefined 会覆盖主题同名键，
 * React 对 undefined 样式按「未设置」处理，主题值被静默丢弃；先过滤再展开。
 */
export function pickDefined(style: React.CSSProperties): React.CSSProperties {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(style)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as React.CSSProperties;
}

/**
 * tagColor — 标签名 → 稳定彩色点
 *
 * 调色板与侧栏清单色一致的观感语言（用户数据色，明暗主题下均可读，
 * 与 TodoSidebar 的 LIST_COLOR_OPTIONS 同一系语义：这是内容色不是主题 token）。
 * 同名标签在任何入口渲染同一颜色（djb2 哈希取模）。
 */

const TAG_DOT_PALETTE = [
  '#ef4444', // red
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#14b8a6', // teal
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#ec4899', // pink
] as const;

export function tagDotColor(tag: string): string {
  let hash = 5381;
  for (let i = 0; i < tag.length; i++) {
    hash = ((hash << 5) + hash + tag.charCodeAt(i)) | 0;
  }
  return TAG_DOT_PALETTE[Math.abs(hash) % TAG_DOT_PALETTE.length];
}

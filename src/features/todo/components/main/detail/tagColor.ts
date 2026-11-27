/**
 * tagColor — 标签语义色解析
 *
 * 标签统一采用中性语义令牌，避免硬编码彩虹色点。
 */

export function tagDotColor(_tag: string): string {
  return 'hsl(var(--muted-foreground))';
}

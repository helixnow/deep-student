/** 非空 href 才允许直接写入 link mark */
export function isNonEmptyHref(href?: string | null): boolean {
  return typeof href === 'string' && href.trim().length > 0;
}

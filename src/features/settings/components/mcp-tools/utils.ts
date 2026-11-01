// 辅助函数
export function stripMcpPrefix(name?: string): string {
  if (!name) return '';
  // 处理多种 namespace 格式: mcp__xxx__, builtin-, xxx: 等
  // 第三条正则限制前缀最长 32 字符且不含 /，避免误匹配 URL
  return name
    .replace(/^mcp__[^_]+__/, '')
    .replace(/^builtin-/, '')
    .replace(/^[a-zA-Z0-9_-]{1,32}:/, '');
}

export function formatDateTime(timestamp?: number): string {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  try {
    // 使用浏览器当前语言环境
    const locale = navigator.language || 'en-US';
    return date.toLocaleString(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  } catch {
    return date.toISOString().replace('T', ' ').slice(0, 19);
  }
}

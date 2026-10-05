/**
 * 待办关联资料的取值约定（attachments_json 字符串数组）：资源 = DSTU 根路径 `/<id>`，外链 = http(s) URL。
 * 打开：两种壳都走 NAVIGATE_TO_VIEW + openResource（学习桌面按 id 前缀开对应应用）。
 */
export const isLinkUrl = (value: string): boolean => /^https?:\/\//i.test(value);

export function linkedResourceValue(node: { id: string }): string {
  return `/${node.id}`;
}

export function linkUrlLabel(value: string): string {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return value;
  }
}

export function openLinkedResource(value: string): void {
  if (isLinkUrl(value)) {
    void import('@tauri-apps/plugin-opener')
      .then(({ openUrl }) => openUrl(value))
      .catch(() => { window.open(value, '_blank', 'noopener,noreferrer'); });
    return;
  }
  window.dispatchEvent(new CustomEvent('NAVIGATE_TO_VIEW', {
    detail: { view: 'learning-hub', openResource: value.startsWith('/') ? value : `/${value}` },
  }));
}

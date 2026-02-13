/**
 * 构建附件解析状态使用的唯一键，避免同名文件互相覆盖。
 */
export const buildAttachmentKey = (
  name: string,
  size: number | undefined,
  type: string | undefined,
): string => {
  const safeName = name || 'unnamed';
  const safeSize = typeof size === 'number' ? size : -1;
  const safeType = type || 'unknown';
  return `${safeName}__${safeSize}__${safeType}`;
};

export const buildFileAttachmentKey = (file: File): string =>
  buildAttachmentKey(file.name, file.size, file.type);


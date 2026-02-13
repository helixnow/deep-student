export function normalizeAttachments<T = any>(attachments: T[]): T[] {
  return Array.isArray(attachments) ? attachments : [];
}

export default { normalizeAttachments };

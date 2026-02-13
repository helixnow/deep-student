export function normalizeBase64Payload(input?: string | null): string | null {
  if (!input || typeof input !== 'string') return null;
  const pure = input.startsWith('data:') ? (input.split(',')[1] || '') : input;
  return pure.length >= 16 ? pure : null;
}

export function buildBase64Fingerprint(input?: string | null): string | null {
  const pure = normalizeBase64Payload(input);
  if (!pure) return null;
  const prefix = pure.substring(0, 128);
  const suffix = pure.length > 4096 ? pure.substring(pure.length - 128) : '';
  let hash = 0x811c9dc5 >>> 0;
  const sample = prefix + suffix;
  for (let i = 0; i < sample.length; i++) {
    hash ^= sample.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `${prefix}_len${pure.length.toString(16)}_${hash.toString(16)}`;
}

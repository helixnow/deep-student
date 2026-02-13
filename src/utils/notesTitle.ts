export function deriveNoteTitleText(text?: string, fallback?: string): string {
  const candidates = (text ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  if (candidates.length > 0) {
    return candidates[0].slice(0, 80);
  }

  if (fallback) {
    const trimmed = fallback.trim();
    if (trimmed) {
      return trimmed.slice(0, 80);
    }
  }

  return '';
}













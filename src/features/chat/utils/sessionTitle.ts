export function getSessionTitleText(title: unknown, fallback: string): string {
  if (typeof title === 'string') {
    const normalized = title.trim();
    return normalized.length > 0 ? normalized : fallback;
  }

  if (title && typeof title === 'object') {
    const record = title as Record<string, unknown>;

    for (const key of ['title', 'name', 'label']) {
      const value = record[key];
      if (typeof value === 'string') {
        const normalized = value.trim();
        if (normalized.length > 0) {
          return normalized;
        }
      }
    }
  }

  return fallback;
}

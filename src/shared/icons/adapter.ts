/**
 * Icon adapter utilities for Lucide → Phosphor migration.
 * Converts Tailwind size classes to Phosphor size prop values.
 */

const TAILWIND_SIZE_MAP: Record<string, number> = {
  'w-3 h-3': 12,
  'h-3 w-3': 12,
  'w-3.5 h-3.5': 14,
  'h-3.5 w-3.5': 14,
  'w-4 h-4': 16,
  'h-4 w-4': 16,
  'w-5 h-5': 20,
  'h-5 w-5': 20,
  'w-6 h-6': 24,
  'h-6 w-6': 24,
  'w-7 h-7': 28,
  'h-7 w-7': 28,
  'w-8 h-8': 32,
  'h-8 w-8': 32,
  'w-10 h-10': 40,
  'h-10 w-10': 40,
  'w-12 h-12': 48,
  'h-12 w-12': 48,
  'w-16 h-16': 64,
  'h-16 w-16': 64,
};

/**
 * Extract numeric size from Tailwind className string.
 * Returns undefined if no size class found (Phosphor defaults to 16).
 */
export function extractSizeFromClassName(className?: string): number | undefined {
  if (!className) return undefined;
  for (const [pattern, size] of Object.entries(TAILWIND_SIZE_MAP)) {
    const parts = pattern.split(' ');
    if (className.includes(parts[0]) && className.includes(parts[1])) {
      return size;
    }
  }
  return undefined;
}

/**
 * Strip w-N h-N size classes from className, preserving other classes (colors, animate-spin, etc.)
 */
export function stripSizeClasses(className?: string): string | undefined {
  if (!className) return undefined;
  const stripped = className
    .replace(/\b[wh]-(?:\d+\.?\d*|\[\d+px\])\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped || undefined;
}

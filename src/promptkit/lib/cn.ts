// Minimal cn utility compatible with Tailwind merge
import { twMerge } from 'tailwind-merge';

type ClassValue = string | number | null | undefined | false | Record<string, boolean> | ClassValue[];

function clsx(...inputs: ClassValue[]): string {
  const classes: string[] = [];
  for (const input of inputs) {
    if (!input) continue;
    if (typeof input === 'string' || typeof input === 'number') {
      classes.push(String(input));
    } else if (Array.isArray(input)) {
      const nested = clsx(...input);
      if (nested) classes.push(nested);
    } else if (typeof input === 'object') {
      for (const [key, value] of Object.entries(input)) {
        if (value) classes.push(key);
      }
    }
  }
  return classes.join(' ');
}

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(...inputs));
}


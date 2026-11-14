/**
 * The goldens in this directory were recorded with the default locale resolving to English (`LANG=C.UTF-8`). Without
 * an explicit locale, `localeCompare` and `toLocale*String` follow the runner's `LC_ALL`/`LANG` (under zh_CN: pinyin
 * order, `09:42:00` instead of `9:42:00 AM`), so tests whose goldens capture them pin that default to `en-US`.
 *
 * Patched in place rather than with `vi.spyOn`, because the evidence tests call `vi.restoreAllMocks()` after each case.
 */
import { afterAll, beforeAll } from 'vitest';

const LOCALE = 'en-US';

type Patch = { target: object; key: string; localesAt: number };

const PATCHES: Patch[] = [
  { target: String.prototype, key: 'localeCompare', localesAt: 1 },
  { target: Date.prototype, key: 'toLocaleString', localesAt: 0 },
  { target: Date.prototype, key: 'toLocaleDateString', localesAt: 0 },
  { target: Date.prototype, key: 'toLocaleTimeString', localesAt: 0 },
  { target: Number.prototype, key: 'toLocaleString', localesAt: 0 },
];

/** Returns the function that puts the original methods back. */
export function pinDefaultLocale(): () => void {
  const originals = PATCHES.map(({ target, key, localesAt }) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key)!;
    const original = descriptor.value as (...args: unknown[]) => unknown;
    Object.defineProperty(target, key, {
      ...descriptor,
      value: function (this: unknown, ...args: unknown[]) {
        if (args[localesAt] === undefined) {
          args.length = Math.max(args.length, localesAt + 1);
          args[localesAt] = LOCALE;
        }
        return original.apply(this, args);
      },
    });
    return { target, key, descriptor };
  });
  return () => {
    for (const { target, key, descriptor } of originals) Object.defineProperty(target, key, descriptor);
  };
}

/** Pins the default locale for every case of the calling test file. */
export function pinDefaultLocaleForFile(): void {
  let restore = () => {};
  beforeAll(() => {
    restore = pinDefaultLocale();
  });
  afterAll(() => restore());
}

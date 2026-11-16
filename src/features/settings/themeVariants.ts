/**
 * `theme.variants` (contracts/surfaces.ts): the user's pick among contributed CSS-variable variants, and the controller
 * that writes the picked variant onto `<html>`.
 *
 * - The pick is `<plugin id>/<contribution id>` in localStorage (per device, like the color mode), or null = default.
 * - The controller follows the slot (install / unload), the pick and the color mode (`.dark` / `data-theme` on
 *   `<html>`): it always removes what it set before applying the current variant's `light` or `dark` set, and restores
 *   inline values that were there before (the custom palette also writes inline variables).
 * - A pick whose plugin is not installed applies nothing but is kept, so the variant returns with its plugin.
 *
 * Dependency-free: imported by the settings plugin at startup and by the appearance settings picker.
 */
import { useCallback, useSyncExternalStore } from 'react';
import type { SlotEntry, SlotStore } from '@/ui-kernel/slots';

export const THEME_VARIANT_SLOT = 'theme.variants';
export const THEME_VARIANT_STORAGE_KEY = 'ds.ui.themeVariant';

const listeners = new Set<() => void>();
let selected: string | null = readStored();

function readStored(): string | null {
  try {
    return globalThis.localStorage?.getItem(THEME_VARIANT_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

/** Stable key of a variant entry: `<plugin id>/<contribution id>`. */
export function themeVariantKey(entry: Pick<SlotEntry<unknown>, 'owner' | 'id'>): string {
  return `${entry.owner}/${entry.id}`;
}

export function getSelectedThemeVariant(): string | null {
  return selected;
}

/** Picks a variant by key (null = default theme). Persisted per device. */
export function setSelectedThemeVariant(key: string | null): void {
  if (key === selected) return;
  selected = key;
  try {
    if (key) globalThis.localStorage?.setItem(THEME_VARIANT_STORAGE_KEY, key);
    else globalThis.localStorage?.removeItem(THEME_VARIANT_STORAGE_KEY);
  } catch {
    // storage unavailable: the pick lasts for this session
  }
  for (const fn of [...listeners]) fn();
}

export function subscribeSelectedThemeVariant(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** `[pick, setPick]` for settings UI. */
export function useSelectedThemeVariant(): [string | null, (key: string | null) => void] {
  const value = useSyncExternalStore(subscribeSelectedThemeVariant, getSelectedThemeVariant, getSelectedThemeVariant);
  return [value, useCallback((key: string | null) => setSelectedThemeVariant(key), [])];
}

function isDarkRoot(root: HTMLElement): boolean {
  return root.classList.contains('dark') || root.getAttribute('data-theme') === 'dark';
}

/**
 * Starts applying the picked variant from `slots` to `root` (default: `document.documentElement`); returns the stop
 * function, which also removes the applied variables. No-op without a DOM.
 */
export function startThemeVariantController(slots: SlotStore, root: HTMLElement | undefined = globalThis.document?.documentElement): () => void {
  if (!root) return () => {};
  /** Applied property → the inline value it had before (empty = none). */
  const applied = new Map<string, string>();

  const clear = () => {
    for (const [prop, previous] of applied) {
      if (previous) root.style.setProperty(prop, previous);
      else root.style.removeProperty(prop);
    }
    applied.clear();
  };

  const apply = () => {
    clear();
    const key = selected;
    if (!key) return;
    const entry = slots.list(THEME_VARIANT_SLOT).find((e) => themeVariantKey(e) === key);
    if (!entry) return;
    const variables = (isDarkRoot(root) ? entry.value?.dark : entry.value?.light) ?? {};
    for (const [prop, value] of Object.entries(variables)) {
      if (!prop.startsWith('--') || typeof value !== 'string') continue;
      applied.set(prop, root.style.getPropertyValue(prop));
      root.style.setProperty(prop, value);
    }
  };

  apply();
  const stopSlot = slots.subscribe(THEME_VARIANT_SLOT, apply);
  const stopPick = subscribeSelectedThemeVariant(apply);
  // Color mode switches toggle class / data-theme; style writes (ours, the custom palette's) are not observed.
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(apply) : null;
  observer?.observe(root, { attributes: true, attributeFilter: ['class', 'data-theme'] });
  return () => {
    observer?.disconnect();
    stopSlot();
    stopPick();
    clear();
  };
}

import { useState, useEffect, useCallback } from 'react';

const UILAB_STORAGE_KEY = 'DSTU_UI_LAB_ENABLED';

let listeners = new Set<() => void>();

export function isUILabEnabled(): boolean {
  try {
    return localStorage.getItem(UILAB_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setUILabEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(UILAB_STORAGE_KEY, String(enabled));
  } catch {}
  listeners.forEach(fn => fn());
}

export function subscribeUILabToggle(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useIsUILabEnabled(): boolean {
  const [enabled, setEnabled] = useState(isUILabEnabled);

  useEffect(() => {
    const unsubscribe = subscribeUILabToggle(() => {
      setEnabled(isUILabEnabled());
    });
    return unsubscribe;
  }, []);

  return enabled;
}

export function useUILabToggle(): [boolean, () => void] {
  const enabled = useIsUILabEnabled();
  const toggle = useCallback(() => setUILabEnabled(!enabled), [enabled]);
  return [enabled, toggle];
}

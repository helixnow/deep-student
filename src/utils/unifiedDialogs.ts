import { showGlobalNotification } from '@/components/UnifiedNotification';
import { t } from './i18n';

type NotificationLevel = 'success' | 'error' | 'warning' | 'info';

interface UnifiedConfirmOptions {
  key?: string;
  windowMs?: number;
  level?: NotificationLevel;
  hint?: string;
}

const pendingConfirmations = new Map<string, number>();

export function unifiedAlert(message: string, level: NotificationLevel = 'info'): void {
  showGlobalNotification(level, message);
}

export function unifiedConfirm(message: string, options: UnifiedConfirmOptions = {}): boolean {
  const windowMs = options.windowMs ?? 8000;
  const now = Date.now();
  const key = options.key ?? message;

  const expiresAt = pendingConfirmations.get(key) ?? 0;
  if (expiresAt > now) {
    pendingConfirmations.delete(key);
    return true;
  }

  pendingConfirmations.set(key, now + windowMs);
  const hint =
    options.hint ??
    t('utils.dialogs.confirm_hint', { seconds: Math.max(1, Math.floor(windowMs / 1000)) });

  showGlobalNotification(options.level ?? 'warning', `${message}\n${hint}`);
  return false;
}


export function unifiedPrompt(message: string, defaultValue = ''): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const promptFn = (window as unknown as Record<string, unknown>)['prompt'];
  if (typeof promptFn !== 'function') {
    showGlobalNotification('warning', t('utils.dialogs.prompt_unsupported'));
    return null;
  }

  return (promptFn as (msg?: string, defaultVal?: string) => string | null)(message, defaultValue);
}

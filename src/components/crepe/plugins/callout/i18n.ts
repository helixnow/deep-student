import i18next from 'i18next';

import type { CalloutType } from './types';

const TYPE_LABEL_KEYS: Record<CalloutType, string> = {
  note: 'notes:callout.type.note',
  tip: 'notes:callout.type.tip',
  warning: 'notes:callout.type.warning',
  danger: 'notes:callout.type.danger',
  info: 'notes:callout.type.info',
};

export function tCalloutTypeLabel(type: CalloutType): string {
  return i18next.t(TYPE_LABEL_KEYS[type]);
}

export function tCalloutCycleAriaLabel(): string {
  return i18next.t('notes:callout.cycleType');
}

export function tCalloutFoldAriaLabel(): string {
  return i18next.t('notes:callout.toggleFold', { defaultValue: '折叠或展开' });
}

export function tCalloutTitlePlaceholder(type: CalloutType): string {
  return tCalloutTypeLabel(type);
}

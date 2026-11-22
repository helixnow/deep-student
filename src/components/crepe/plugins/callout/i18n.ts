import i18next from 'i18next';

import type { CalloutType } from './types';

const TYPE_LABEL_KEYS: Record<CalloutType, string> = {
  note: 'notes:callout.type.note',
  tip: 'notes:callout.type.tip',
  warning: 'notes:callout.type.warning',
  danger: 'notes:callout.type.danger',
  info: 'notes:callout.type.info',
};

const TYPE_DEFAULT_LABELS: Record<CalloutType, string> = {
  note: '笔记',
  tip: '提示',
  warning: '警告',
  danger: '危险',
  info: '信息',
};

function translate(key: string, defaultValue: string): string {
  const value = i18next.t(key, { defaultValue });
  return value || defaultValue;
}

export function tCalloutTypeLabel(type: CalloutType): string {
  return translate(TYPE_LABEL_KEYS[type], TYPE_DEFAULT_LABELS[type]);
}

export function tCalloutCycleAriaLabel(): string {
  return translate('notes:callout.cycleType', '切换提示块类型');
}

export function tCalloutPickerAriaLabel(): string {
  return translate('notes:callout.pickerLabel', tCalloutCycleAriaLabel());
}

export function tCalloutFoldAriaLabel(): string {
  return translate('notes:callout.toggleFold', '折叠或展开');
}

export function tCalloutTitlePlaceholder(type: CalloutType): string {
  return tCalloutTypeLabel(type);
}

export function tCalloutEditTitleAriaLabel(): string {
  return translate('notes:callout.editTitle', '编辑标题');
}

export function tCalloutTitleInputAriaLabel(): string {
  return translate('notes:callout.titleInput', '提示块标题');
}

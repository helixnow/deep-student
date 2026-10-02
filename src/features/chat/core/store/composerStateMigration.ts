import {
  COMPOSER_PANEL_KEYS,
  createDefaultPanelStates,
  type PanelStates,
} from '../types/common';

export interface RestoredComposerState {
  inputValue: string;
  panelStates: PanelStates;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize the persisted InputBar state before split Composer components see
 * it. v0.9.44 payloads may omit current keys and still contain retired
 * rag/search/learn keys; malformed imports can also violate the TS-only shape.
 */
export function normalizeRestoredComposerState(state: unknown): RestoredComposerState {
  const record = isRecord(state) ? state : {};
  const persistedPanels = isRecord(record.panelStates) ? record.panelStates : {};
  const panelStates = createDefaultPanelStates();

  COMPOSER_PANEL_KEYS.forEach((panel) => {
    // 附件面板是随「添加附件」临时弹出的浮层：附件随消息发出后待发送区为空，
    // 恢复成打开只会得到一个压在对话上的空「附件 (0)」
    if (panel === 'attachment') return;
    if (typeof persistedPanels[panel] === 'boolean') {
      panelStates[panel] = persistedPanels[panel];
    }
  });

  return {
    inputValue: typeof record.inputValue === 'string' ? record.inputValue : '',
    panelStates,
  };
}

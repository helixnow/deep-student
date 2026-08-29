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
    if (typeof persistedPanels[panel] === 'boolean') {
      panelStates[panel] = persistedPanels[panel];
    }
  });

  return {
    inputValue: typeof record.inputValue === 'string' ? record.inputValue : '',
    panelStates,
  };
}

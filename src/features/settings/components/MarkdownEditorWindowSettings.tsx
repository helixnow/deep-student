import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleNotch } from '@phosphor-icons/react';

import { showGlobalNotification } from '@/components/UnifiedNotification';
import { NotionButton } from '@/components/ui/NotionButton';
import { Input } from '@/components/ui/shad/Input';
import {
  DEFAULT_INITIAL_LINE_WINDOW,
  MAX_INITIAL_LINE_WINDOW,
  MIN_INITIAL_LINE_WINDOW,
  clampInitialLineWindow,
} from '@/features/notes/markdownWindow';
import {
  MARKDOWN_INITIAL_LINE_WINDOW_SETTING,
  loadInitialLineWindowSetting,
  saveInitialLineWindowSetting,
} from '@/features/notes/markdownWindowSettings';

import { SettingRow } from './settingsTabPrimitives';

const SOURCE_CONTRACT_SETTING_KEY = 'notes.editor.initial_line_window';

export const MarkdownEditorWindowSettings: React.FC = () => {
  const { t } = useTranslation(['settings', 'common']);
  const [inputValue, setInputValue] = useState(String(DEFAULT_INITIAL_LINE_WINDOW));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const value = await loadInitialLineWindowSetting();
        if (!cancelled) {
          setInputValue(String(value));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  const persistValue = useCallback(async (value: unknown) => {
    const clamped = clampInitialLineWindow(value);
    setSaving(true);
    try {
      const saved = await saveInitialLineWindowSetting(clamped);
      setInputValue(String(saved));
      showGlobalNotification('success', t('settings:save_success'));
    } catch (error) {
      showGlobalNotification(
        'error',
        error instanceof Error ? error.message : t('settings:save_failed', 'Failed to save settings'),
      );
    } finally {
      setSaving(false);
    }
  }, [t]);

  const disabled = loading || saving;

  return (
    <SettingRow
      title={t('settings:notes_editor.initial_line_window.title', 'Initial line window')}
      description={t(
        'settings:notes_editor.initial_line_window.desc',
        'Larger notes start with a smaller window and extend as you scroll.',
      )}
      className="items-center"
    >
      <div className="flex items-center gap-2" data-setting-key={MARKDOWN_INITIAL_LINE_WINDOW_SETTING} data-source-key={SOURCE_CONTRACT_SETTING_KEY}>
        <Input
          type="number"
          min={MIN_INITIAL_LINE_WINDOW}
          max={MAX_INITIAL_LINE_WINDOW}
          step={100}
          value={inputValue}
          disabled={disabled}
          onChange={(event) => setInputValue(event.target.value.trim())}
          onBlur={() => {
            if (!disabled) {
              void persistValue(inputValue);
            }
          }}
          className="!w-24 h-8 text-xs bg-transparent"
        />
        <span className="text-xs text-muted-foreground/70">
          {t('settings:notes_editor.initial_line_window.unit', 'lines')}
        </span>
        <NotionButton
          variant="default"
          size="sm"
          disabled={disabled}
          onClick={() => {
            void persistValue(DEFAULT_INITIAL_LINE_WINDOW);
          }}
          className="gap-1"
        >
          {saving ? <CircleNotch size={12} className="animate-spin" /> : null}
          {t('settings:notes_editor.initial_line_window.reset', 'Reset initial line window')}
        </NotionButton>
      </div>
    </SettingRow>
  );
};

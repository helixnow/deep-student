import React from 'react';
import { useTranslation } from 'react-i18next';
import { getPracticeShortcutHints, type PracticeShortcutOptions } from './usePracticeShortcuts';

export function PracticeShortcutHints(props: Pick<PracticeShortcutOptions, 'actions' | 'optionKeys' | 'primaryLabel'>) {
  const { t } = useTranslation('practice');
  return (
    <div className="space-y-1.5 text-xs text-muted-foreground">
      {getPracticeShortcutHints(props).map(hint => (
        <div key={hint.label} className="flex items-start justify-between gap-4">
          <span>{t(hint.label)}</span>
          <kbd className="max-w-48 rounded bg-muted px-1.5 py-0.5 text-right break-words">{hint.keys}</kbd>
        </div>
      ))}
    </div>
  );
}

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
          <kbd className="max-w-48 rounded-md border border-border/45 bg-foreground/[0.04] px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-right break-words text-foreground/80">{hint.keys}</kbd>
        </div>
      ))}
    </div>
  );
}

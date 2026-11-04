export type InkCreateMode = 'paged' | 'board';

export interface InkCreateChoice {
  mode: InkCreateMode;
  labelKey: string;
  testId: string;
  requiresBoardCap?: true;
}

/** Shared create-menu rows for the finder toolbar, mobile menu and context menu. */
export const INK_CREATE_CHOICES: readonly InkCreateChoice[] = [
  { mode: 'paged', labelKey: 'finder.toolbar.newInkPaged', testId: 'finder-create-ink-paged' },
  {
    mode: 'board',
    labelKey: 'finder.toolbar.newInkBoard',
    testId: 'finder-create-ink-board',
    requiresBoardCap: true,
  },
];

export function visibleInkCreateChoices(boardEnabled: boolean): readonly InkCreateChoice[] {
  return INK_CREATE_CHOICES.filter((choice) => !choice.requiresBoardCap || boardEnabled);
}

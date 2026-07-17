import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { hasWorkbenchAppIcon, WorkbenchAppIcon } from '../WorkbenchAppIcon';

const TYPE_IDS = [
  'notes', 'todo', 'chat', 'pomodoro', 'translation', 'skills',
  'textbook', 'browser', 'templates', 'sandbox', 'flashcards', 'settings',
  'exam', 'image', 'file', 'file-preview', 'taskDashboard', 'files', 'essay',
];

describe('WorkbenchAppIcon', () => {
  it.each(TYPE_IDS)('renders the %s artwork as a stable SVG', (typeId) => {
    const { container } = render(<WorkbenchAppIcon typeId={typeId} />);
    const svg = container.querySelector(`[data-workbench-app-icon="${typeId}"]`);
    expect(svg).toHaveAttribute('viewBox', '0 0 64 64');
    expect(svg?.querySelector('path, rect, circle, text')).not.toBeNull();
  });

  it('reports unknown app types and renders no placeholder', () => {
    expect(hasWorkbenchAppIcon('future-app')).toBe(false);
    render(<WorkbenchAppIcon typeId="future-app" />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});

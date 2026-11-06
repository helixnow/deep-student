import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InkDrawingToolbar } from '../InkDrawingToolbar';
import { clampEraserSize, clampInkOpacity, clampInkWidth, defaultInkToolPreferences, type InkToolName } from '../toolSettings';

vi.mock('@/hooks/useBreakpoint', () => ({ useIsMobile: () => false }));
vi.mock('../InkDiagnosticsControls', () => ({ InkDiagnosticsControls: () => <div data-testid="diagnostics" /> }));

function Harness({ variant }: { variant: 'paged' | 'board' }) {
  const [tool, setTool] = useState<InkToolName>('pen');
  const [preferences, setPreferences] = useState(defaultInkToolPreferences);
  const settings = preferences.settings[tool];
  const update = (patch: Partial<typeof settings>) => setPreferences((current) => ({
    ...current, settings: { ...current.settings, [tool]: { ...current.settings[tool], ...patch } },
  }));
  return <InkDrawingToolbar
    variant={variant} canUndo={false} canRedo={false} tool={tool} {...settings}
    eraserSize={preferences.eraserSize} erasing={false} touchDrawing={false}
    selectionMode="none" selectionActive={false} selectionCanCopy={false}
    onSelectSelectionMode={vi.fn()} onSelectTool={setTool} onSelectColor={(color) => update({ color })}
    onSelectWidth={(width) => update({ width: clampInkWidth(tool, width) })}
    onSelectOpacity={(opacity) => update({ opacity: clampInkOpacity(opacity) })}
    onSelectEraserSize={(size) => setPreferences((current) => ({ ...current, eraserSize: clampEraserSize(size) }))}
    onToggleEraser={vi.fn()} onUndo={vi.fn()} onRedo={vi.fn()} onToggleTouchDrawing={vi.fn()}
    translate={(key) => key}
  />;
}

for (const variant of ['paged', 'board'] as const) {
  const prefix = variant === 'board' ? 'ink-board' : 'ink';
  const settingsId = variant === 'board' ? 'ink-board-settings-toggle' : 'ink-tool-settings';
  describe(`${variant} shared drawing controls`, () => {
    it('normalizes valid colors and restores the last valid value after an invalid draft', () => {
      render(<Harness variant={variant} />);
      fireEvent.click(screen.getByTestId(settingsId));
      const field = screen.getByTestId(`${prefix}-custom-color`);
      fireEvent.change(field, { target: { value: '#abc' } });
      expect(field).toHaveValue('#abc');
      fireEvent.blur(field);
      expect(field).toHaveValue('#aabbcc');
      fireEvent.focus(field);
      fireEvent.change(field, { target: { value: 'not a color' } });
      expect(field).toHaveValue('not a color');
      fireEvent.blur(field);
      expect(field).toHaveValue('#aabbcc');
    });

    it('preserves empty numeric drafts while editing and displays bounded values on blur', () => {
      render(<Harness variant={variant} />);
      fireEvent.click(screen.getByTestId(settingsId));
      const width = screen.getByTestId(`${prefix}-width-value`);
      fireEvent.change(width, { target: { value: '' } });
      expect(width).toHaveValue(null);
      fireEvent.blur(width);
      expect(width).toHaveValue(8);
      fireEvent.change(width, { target: { value: '100' } });
      fireEvent.blur(width);
      expect(width).toHaveValue(64);
      const eraser = screen.getByTestId(`${prefix}-eraser-size`);
      fireEvent.change(eraser, { target: { value: '1' } });
      fireEvent.blur(eraser);
      expect(eraser).toHaveValue(4);
    });

    it('keeps each tool settings independent and does not overwrite the field on focus', () => {
      render(<Harness variant={variant} />);
      fireEvent.click(screen.getByTestId(settingsId));
      const color = screen.getByTestId(`${prefix}-custom-color`) as HTMLInputElement;
      fireEvent.change(color, { target: { value: '#16a34a' } });
      fireEvent.blur(color);
      fireEvent.click(screen.getByTestId(`${prefix}-tool-highlighter`));
      expect(color).toHaveValue('#000000');
      color.setSelectionRange(0, color.value.length);
      fireEvent.focus(color);
      expect(color.selectionStart).toBe(0);
      expect(color.selectionEnd).toBe(7);
      fireEvent.change(color, { target: { value: '#ffd400' } });
      fireEvent.blur(color);
      const opacity = screen.getByTestId(`${prefix}-opacity`);
      fireEvent.change(opacity, { target: { value: '0.25' } });
      fireEvent.blur(opacity);
      fireEvent.click(screen.getByTestId(`${prefix}-tool-pen`));
      expect(color).toHaveValue('#16a34a');
      expect(screen.queryByTestId(`${prefix}-opacity`)).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId(`${prefix}-tool-highlighter`));
      expect(color).toHaveValue('#ffd400');
      expect(screen.getByTestId(`${prefix}-opacity`)).toHaveValue(0.25);
    });
  });
}

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import TooltipStyleDebugPlugin from '@/debug-panel/plugins/TooltipStyleDebugPlugin';

describe('TooltipStyleDebugPlugin', () => {
  it('renders all tooltip variants for side-by-side debugging', () => {
    render(
      <TooltipStyleDebugPlugin
        visible
        onClose={() => {}}
        isActive
        isActivated
      />
    );

    expect(screen.getByText('CommonTooltip')).toBeInTheDocument();
    expect(screen.getByText('shadcn Tooltip')).toBeInTheDocument();
    expect(screen.getByText('promptkit Tooltip')).toBeInTheDocument();
    expect(screen.getByText('原生 title')).toBeInTheDocument();
  });

  it('surfaces the promptkit implementation note for debugging', () => {
    render(
      <TooltipStyleDebugPlugin
        visible
        onClose={() => {}}
        isActive
        isActivated
      />
    );

    expect(screen.getByText(/当前实现是轻量占位/i)).toBeInTheDocument();
    expect(screen.getByText(/不会像另外两套一样自动悬浮出层/i)).toBeInTheDocument();
  });
});

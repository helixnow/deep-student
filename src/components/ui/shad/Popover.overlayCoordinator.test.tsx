import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CommonTooltip } from '../../shared/CommonTooltip';
import { OverlayCoordinatorProvider } from '../../shared/OverlayCoordinator';
import { Popover, PopoverContent, PopoverTrigger } from './Popover';

describe('Popover overlay coordination', () => {
  it('suppresses trigger tooltips while the popover is open', () => {
    render(
      <OverlayCoordinatorProvider>
        <Popover>
          <CommonTooltip content="打开详情" delay={0}>
            <PopoverTrigger asChild>
              <button type="button">详情</button>
            </PopoverTrigger>
          </CommonTooltip>
          <PopoverContent>
            <div>详情内容</div>
          </PopoverContent>
        </Popover>
      </OverlayCoordinatorProvider>
    );

    const trigger = screen.getByRole('button', { name: '详情' });
    fireEvent.mouseEnter(trigger);
    expect(screen.getByRole('tooltip')).toHaveTextContent('打开详情');

    fireEvent.click(trigger);

    expect(screen.getByRole('dialog')).toHaveTextContent('详情内容');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    fireEvent.mouseEnter(trigger);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});

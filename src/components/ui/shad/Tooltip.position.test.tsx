import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Tooltip, TooltipContent, TooltipTrigger } from './Tooltip';

describe('Tooltip viewport placement', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('flips a top tooltip below its trigger when the top edge has no room', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this.tagName === 'BUTTON') {
        return {
          x: 300,
          y: 10,
          top: 10,
          right: 340,
          bottom: 30,
          left: 300,
          width: 40,
          height: 20,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return {
        x: 0,
        y: 0,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      } as DOMRect;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function () {
      return this.getAttribute('role') === 'tooltip' ? 200 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function () {
      return this.getAttribute('role') === 'tooltip' ? 100 : 0;
    });

    render(
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button">Details</button>
        </TooltipTrigger>
        <TooltipContent side="top">Tooltip details</TooltipContent>
      </Tooltip>,
    );

    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Details' }));

    await waitFor(() => {
      const tooltip = screen.getByRole('tooltip');
      expect(tooltip).toHaveAttribute('data-side', 'bottom');
      expect(tooltip).toHaveStyle({ top: '38px', left: '220px', visibility: 'visible' });
    });
  });
});

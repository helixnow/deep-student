import React, { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/shad/Tabs';

describe('Tabs Stage 5 regressions', () => {
  it('ignores ArrowLeft/ArrowRight/Home/End inside nested inputs inside TabsList', () => {
    const onValueChange = vi.fn();
    render(
      <Tabs value="one" onValueChange={onValueChange}>
        <TabsList>
          <TabsTrigger value="one">Tab One</TabsTrigger>
          <TabsTrigger value="two">Tab Two</TabsTrigger>
          <input aria-label="nested-filter" defaultValue="abc" />
        </TabsList>
        <TabsContent value="one">Panel One</TabsContent>
        <TabsContent value="two">Panel Two</TabsContent>
      </Tabs>,
    );

    const input = screen.getByLabelText('nested-filter');
    input.focus();
    fireEvent.keyDown(input, { key: 'ArrowRight' });
    fireEvent.keyDown(input, { key: 'ArrowLeft' });
    fireEvent.keyDown(input, { key: 'Home' });
    fireEvent.keyDown(input, { key: 'End' });

    expect(onValueChange).not.toHaveBeenCalled();

    const firstTab = screen.getByRole('tab', { name: 'Tab One' });
    firstTab.focus();
    fireEvent.keyDown(firstTab, { key: 'ArrowRight' });
    expect(onValueChange).toHaveBeenCalledWith('two');
  });

  it('keeps forceMount TabsContent mounted while hidden and preserves draft state', () => {
    function DraftFormHarness() {
      const [tab, setTab] = useState('sync');
      const [draft, setDraft] = useState('');
      return (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="sync">Sync</TabsTrigger>
          </TabsList>
          <TabsContent value="overview">Overview Body</TabsContent>
          <TabsContent value="sync" forceMount>
            <input
              aria-label="sync-draft-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </TabsContent>
        </Tabs>
      );
    }

    render(<DraftFormHarness />);

    const draftInput = screen.getByLabelText('sync-draft-input') as HTMLInputElement;
    fireEvent.change(draftInput, { target: { value: 'https://dav.example.com' } });
    expect(draftInput.value).toBe('https://dav.example.com');

    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    const hiddenPanel = document.querySelector('[data-state="inactive"][role="tabpanel"]');
    expect(hiddenPanel).toBeInTheDocument();
    expect(hiddenPanel).toHaveAttribute('hidden');
    expect(hiddenPanel?.className).toContain('hidden');

    fireEvent.click(screen.getByRole('tab', { name: 'Sync' }));
    expect((screen.getByLabelText('sync-draft-input') as HTMLInputElement).value).toBe(
      'https://dav.example.com',
    );
  });
});

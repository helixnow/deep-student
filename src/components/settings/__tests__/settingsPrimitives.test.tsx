import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import * as shared from '../index';
import * as legacyCommon from '@/features/settings/components/SettingsCommon';
import * as legacyPrimitives from '@/features/settings/components/settingsTabPrimitives';

describe('shared settings primitives', () => {
  it('keeps the original import paths pointing to the same exports', () => {
    for (const [name, value] of Object.entries({ ...legacyCommon, ...legacyPrimitives })) {
      expect(shared[name], name).toBe(value);
    }
  });

  it('renders the shared section, group and row without a settings feature provider', () => {
    const { container } = render(
      <shared.SettingSection title="Plugins" description="Installed extensions">
        <shared.SettingsGroup title="Official" actions={<button>Refresh</button>}>
          <shared.SettingRow title="Example" description="Enabled extension">
            <button>Configure</button>
          </shared.SettingRow>
        </shared.SettingsGroup>
      </shared.SettingSection>,
    );
    expect(screen.getByRole('heading', { name: 'Plugins' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Official' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Configure' })).toBeInTheDocument();
    expect(container.querySelector('section > .rounded-2xl')).toHaveClass('bg-muted');
    expect(screen.getByText('Example').closest('.group')).toHaveClass(
      ...shared.settingsQuietInteractiveRowClassName.split(' '),
    );
  });
});

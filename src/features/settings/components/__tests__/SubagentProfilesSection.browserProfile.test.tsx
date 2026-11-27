import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@/hooks/useRefreshOnReturn', () => ({
  useRefreshOnReturn: () => undefined,
}));

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: false }),
}));

vi.mock('@/utils/systemFileOpener', () => ({
  canRevealInFolder: () => false,
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('react-i18next', () => {
  const map: Record<string, string> = {
    'settings:subagentProfiles.title': 'Subagent Profiles',
    'settings:subagentProfiles.description': 'Manage available subagent profiles',
    'settings:subagentProfiles.builtin_badge': 'Built-in',
    'settings:subagentProfiles.builtin_names.default': 'Default',
    'settings:subagentProfiles.builtin_names.worker': 'Worker',
    'settings:subagentProfiles.builtin_names.explorer': 'Explorer',
    'settings:subagentProfiles.builtin_names.browser': 'Browser Specialist',
    'settings:subagentProfiles.builtin_descriptions.browser':
      'Least-privilege sandboxed browser subagent for isolated web browsing, reading, interaction, and content extraction.',
    'settings:subagentProfiles.actions.create': 'New profile',
    'settings:subagentProfiles.form.create_title': 'New custom profile',
    'settings:subagentProfiles.form.create_description': 'Fill in details',
    'settings:subagentProfiles.form.create_submit': 'Create',
    'settings:subagentProfiles.form.name': 'Name (id)',
    'settings:subagentProfiles.form.name_placeholder': 'my-researcher',
    'settings:subagentProfiles.form.name_hint': 'Lowercase only',
    'settings:subagentProfiles.form.base': 'Base profile',
    'settings:subagentProfiles.form.base_hint': 'Safe tool boundary',
    'settings:subagentProfiles.form.description': 'Description',
    'settings:subagentProfiles.form.description_placeholder': 'Desc',
    'settings:subagentProfiles.form.model': 'Model (optional)',
    'settings:subagentProfiles.form.model_placeholder': 'Default',
    'settings:subagentProfiles.form.model_hint': 'Exact ID',
    'settings:subagentProfiles.form.instructions': 'Instructions',
    'settings:subagentProfiles.form.instructions_placeholder': 'Prompt',
    'settings:subagentProfiles.form.instructions_hint': 'Optional',
    'settings:subagentProfiles.form.advanced': 'Advanced fields',
    'settings:subagentProfiles.form.advanced_hint': 'Optional YAML',
    'settings:subagentProfiles.empty.title': 'No custom profiles yet',
    'settings:subagentProfiles.empty.description': 'Create one',
    'settings:subagentProfiles.empty.cta': 'New profile',
    'settings:subagentProfiles.errors.name_builtin_conflict':
      'Name must not match a built-in profile (default / worker / explorer / browser)',
    'common:cancel': 'Cancel',
  };
  return {
    initReactI18next: { type: '3rdParty', init: () => undefined },
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) => {
        if (key === 'settings:subagentProfiles.tool_count') return `Tools: ${String(opts?.count ?? 0)}`;
        return map[key] ?? key;
      },
      i18n: { resolvedLanguage: 'en-US', language: 'en-US' },
    }),
  };
});

describe('SubagentProfilesSection built-in browser profile', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invokeMock.mockResolvedValue({
      builtin: [
        { id: 'default', description: 'Default agent', model: null, toolCount: 10 },
        { id: 'worker', description: 'Worker agent', model: null, toolCount: 8 },
        { id: 'explorer', description: 'Explorer agent', model: null, toolCount: 6 },
        { id: 'browser', description: 'Browser subagent', model: null, toolCount: 20 },
      ],
      customFiles: [],
      agentsDir: '/tmp/agents',
    });
  });

  it('renders browser built-in profile, exposes browser in base select, and rejects browser as custom name', async () => {
    const { SubagentProfilesSection } = await import('../SubagentProfilesSection');
    render(<SubagentProfilesSection />);

    await waitFor(() => {
      expect(screen.getByText('Browser Specialist')).toBeTruthy();
    });
    expect(
      screen.getByText(
        'Least-privilege sandboxed browser subagent for isolated web browsing, reading, interaction, and content extraction.',
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: 'New profile' })[0]);

    const baseSelect = screen.getByLabelText(/Base profile/i) as HTMLSelectElement;
    const optionValues = Array.from(baseSelect.options).map((opt) => opt.value);
    expect(optionValues).toEqual(['default', 'worker', 'explorer', 'browser']);

    const nameInput = screen.getByPlaceholderText('my-researcher');
    fireEvent.change(nameInput, { target: { value: 'browser' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Name must not match a built-in profile (default / worker / explorer / browser)',
    );
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});

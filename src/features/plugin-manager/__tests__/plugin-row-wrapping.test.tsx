import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { PluginRow } from '../PluginRow';
import { pluginDescription } from '../presentation';
import { i18nMock, t } from './i18nMock';
import { managedPlugin } from './fixtures';

vi.mock('react-i18next', async () => (await import('./i18nMock')).i18nMock());

const longDescription = 'agentApproval, agentWorkspace, agentWorkspaceTools, agentSkillProviders, agentSkillExecution';

function renderRow(compact: boolean, description = longDescription) {
  return render(
    <PluginRow
      compact={compact}
      plugin={managedPlugin({ id: 'dstu.agent-workspace', displayName: 'Agent Workspace', author: 'Deep Student', description })}
      platform="desktop"
      busy={false}
      errorBudget={null}
      autoUninstalled={null}
      onToggle={() => {}}
      onConfigure={() => {}}
      onUninstall={() => {}}
    />,
  );
}

describe('plugin row wrapping', () => {
  it('overrides the DsButton nowrap primitives in compact rows so long descriptions wrap', () => {
    renderRow(true);

    const button = screen.getByRole('button', { name: /查看/ });
    // `cn()` is plain concatenation: the primitive emits its own `whitespace-nowrap`, and only an
    // `!`-prefixed override beats it in stylesheet order. Assert the winning utility, not its removal.
    const buttonClasses = button.className.split(/\s+/);
    expect(buttonClasses).toContain('whitespace-nowrap');
    expect(buttonClasses).toContain('!whitespace-normal');
    expect(button).toHaveClass('!h-auto');
    expect(button).toHaveClass('!shrink');
    expect(button).toHaveClass('min-w-0');

    const text = screen.getByTestId('plugin-row-text');
    expect(text).toHaveClass('min-w-0', 'whitespace-normal', 'break-words');
    expect(text).toHaveClass('[overflow-wrap:anywhere]');

    const description = screen.getByTestId('plugin-row-description');
    expect(description).toHaveClass('min-w-0', 'whitespace-normal', 'break-words');
    expect(description.className).not.toContain('whitespace-nowrap');

    // The right-hand switch keeps its own footprint instead of squeezing the text column.
    expect(screen.getByRole('switch').className).toContain('shrink-0');
  });

  it('wraps multi-line plugin names and descriptions in the non-compact row', () => {
    renderRow(false);

    const heading = screen.getByRole('heading', { name: 'Agent Workspace' });
    expect(heading).toHaveClass('min-w-0', 'whitespace-normal', 'break-words');
    expect(heading.className).not.toContain('break-all');

    const description = screen.getByTestId('plugin-row-description');
    expect(description).toHaveClass('min-w-0', 'whitespace-normal', 'break-words');
    expect(description).toHaveClass('[overflow-wrap:anywhere]');
  });
});

describe('plugin description presentation', () => {
  it('prefers a localized official description over the raw host service list', () => {
    const plugin = managedPlugin({ id: 'dstu.llm', description: 'llm, embedding@1, llmReranker, llmStreaming' });
    expect(pluginDescription(plugin, t)).toBe('大模型调用、嵌入、重排与 OCR 等 AI 能力');
  });

  it('keeps descriptionKey precedence and falls back to host text for unknown ids', () => {
    const keyed = managedPlugin({ id: 'dstu.llm', descriptionKey: 'custom.description', description: 'raw' });
    expect(pluginDescription(keyed, t)).toBe('custom.description');
    const unknown = managedPlugin({ id: 'community.custom', description: 'A community plugin' });
    expect(pluginDescription(unknown, t)).toBe('A community plugin');
  });
});

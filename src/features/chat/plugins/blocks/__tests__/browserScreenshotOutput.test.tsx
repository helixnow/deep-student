import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ToolOutputView } from '../components/ToolOutputView';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));

afterEach(() => cleanup());

describe('ToolOutputView browser_screenshot summary', () => {
  it('renders resolution, annotated badge, URL host, and locator cleanly', () => {
    render(
      <ToolOutputView
        output={{
          ok: true,
          action: 'screenshot',
          available: true,
          url: 'https://docs.example.com/guide/intro',
          width: 1440,
          height: 900,
          mime_type: 'image/png',
          annotated: true,
          locator: 'runtime://artifacts/browser-screenshots/shot-1.png',
          artifact_path: '/var/data/artifacts/browser-screenshots/shot-1.png',
        }}
      />
    );

    const summary = screen.getByTestId('browser-screenshot-summary');
    expect(summary.textContent).toContain('1440 × 900');
    expect(summary.textContent).toContain('blocks.mcpTool.browserScreenshot.annotated');
    expect(summary.textContent).toContain('docs.example.com');
    expect(summary.textContent).toContain('runtime://artifacts/browser-screenshots/shot-1.png');
  });

  it('omits annotated badge when annotated is false and falls back to artifact_path when locator is absent', () => {
    render(
      <ToolOutputView
        output={{
          ok: true,
          action: 'screenshot',
          available: true,
          url: 'https://example.org/page',
          width: 800,
          height: 600,
          annotated: false,
          artifact_path: 'browser-screenshots/shot-2.png',
        }}
      />
    );

    const summary = screen.getByTestId('browser-screenshot-summary');
    expect(summary.textContent).toContain('800 × 600');
    expect(summary.textContent).not.toContain('blocks.mcpTool.browserScreenshot.annotated');
    expect(summary.textContent).toContain('example.org');
    expect(summary.textContent).toContain('browser-screenshots/shot-2.png');
  });

  it('renders unavailable screenshot capability status cleanly', () => {
    render(
      <ToolOutputView
        output={{
          ok: true,
          action: 'screenshot_capability',
          available: false,
          url: 'https://example.net/',
          reason: 'Platform bridge unavailable',
        }}
      />
    );

    const summary = screen.getByTestId('browser-screenshot-summary');
    expect(summary.textContent).toContain('blocks.mcpTool.browserScreenshot.unavailable');
    expect(summary.textContent).toContain('Platform bridge unavailable');
    expect(summary.textContent).toContain('example.net');
  });
});

import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OpenSourceAcknowledgementsSection,
  loadLegalDocumentText,
} from '../OpenSourceAcknowledgementsSection';

const breakpointMock = vi.hoisted(() => ({
  isSmallScreen: false,
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({
    isSmallScreen: breakpointMock.isSmallScreen,
  }),
  useIsMobile: () => breakpointMock.isSmallScreen,
}));

vi.mock('@/app/navigation/androidBackCoordinator', () => ({
  BACK_PRIORITY: { overlay: 100 },
  registerBackHandler: () => () => undefined,
}));

describe('OpenSourceAcknowledgementsSection', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    breakpointMock.isSmallScreen = false;
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('lists Node/Electron/Capacitor/Cordis/F7-WASI/Docs/Science/Fonts items without stale Tauri/Rust entries', () => {
    render(<OpenSourceAcknowledgementsSection />);
    fireEvent.click(screen.getByRole('button', { name: 'acknowledgements.openSource.openDialog' }));

    for (const expected of [
      'Electron',
      'Chromium',
      'Node.js',
      'Capacitor',
      'Cordis',
      'Symphonia',
      'PDFium',
      'Noto Sans SC (OFL-1.1)',
      'Liberation Sans (OFL-1.1)',
      'Foxit Standard Fonts',
    ]) {
      expect(screen.getByText(expected)).toBeTruthy();
    }

    for (const stale of [
      'Tauri 2',
      'Rusqlite',
      'Tokio',
      'Serde',
      'cmdk',
      'Hello Pangea DnD',
      'SnapDOM',
      'tiktoken-rs',
    ]) {
      expect(screen.queryByText(stale)).toBeNull();
    }
  });

  it('defines all category keys in both en-US and zh-CN settings locales', () => {
    const expectedKeys = [
      'runtimesAndFrameworks',
      'backendAndStorage',
      'f7WasiEngines',
      'documentsAndArchives',
      'editorsAndScience',
      'uiAndInteraction',
      'stateAndLearning',
      'fontsAndAssets',
    ];
    for (const locale of ['en-US', 'zh-CN']) {
      const json = JSON.parse(
        readFileSync(resolve(process.cwd(), `src/locales/${locale}/settings.json`), 'utf8'),
      ) as { acknowledgements: { openSource: { categories: Record<string, string> } } };
      const categories = json.acknowledgements.openSource.categories;
      for (const key of expectedKeys) {
        expect(categories[key], `${locale}.${key}`).toBeTruthy();
      }
      expect(categories.rustEcosystem, `${locale}.rustEcosystem`).toBeUndefined();
    }
  });

  it('loads THIRD_PARTY_NOTICES.txt via Electron resource IPC and falls back to fetch in dev/web/mobile', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'DEV FETCH NOTICES',
    } as Response);
    globalThis.fetch = fetchMock;

    const encoded = new TextEncoder().encode('ELECTRON RESOURCE NOTICES').buffer;
    const invoke = vi.fn().mockResolvedValueOnce(encoded);
    (window as { __TAURI_INTERNALS__?: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke };

    const desktopText = await loadLegalDocumentText('thirdParty');
    expect(desktopText).toBe('ELECTRON RESOURCE NOTICES');
    expect(invoke).toHaveBeenCalledWith('plugin:fs|read_text_file', {
      path: 'licenses/THIRD_PARTY_NOTICES.txt',
      options: { baseDir: 11 },
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // Electron dev fallback when packaged resource does not exist
    invoke.mockRejectedValueOnce(new Error('not found'));
    expect(await loadLegalDocumentText('thirdParty')).toBe('DEV FETCH NOTICES');
    expect(fetchMock).toHaveBeenLastCalledWith('./legal/THIRD_PARTY_NOTICES.txt');

    // Web / Mobile runtime without desktop shell IPC
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    expect(await loadLegalDocumentText('project')).toBe('DEV FETCH NOTICES');
    expect(fetchMock).toHaveBeenLastCalledWith('./legal/DEEPSTUDENT_LICENSE.txt');
  });

  it('renders third-party notices inline on small screens and in a dialog on desktop', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'DEEPSTUDENT THIRD-PARTY NOTICES CONTENT',
    } as Response);

    breakpointMock.isSmallScreen = true;
    render(<OpenSourceAcknowledgementsSection />);
    fireEvent.click(screen.getByRole('button', { name: 'acknowledgements.openSource.openDialog' }));
    fireEvent.click(screen.getByRole('button', { name: 'acknowledgements.openSource.thirdPartyLicense' }));

    await waitFor(() => {
      expect(screen.getByText('DEEPSTUDENT THIRD-PARTY NOTICES CONTENT')).toBeTruthy();
    });
  });
});

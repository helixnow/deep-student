import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts === 'object') {
        return `${key}:${JSON.stringify(opts)}`;
      }
      return key;
    },
  }),
}));

vi.mock('@/features/chat/skills', () => ({
  skillRegistry: {
    get: vi.fn(() => undefined),
  },
  reloadSkills: vi.fn(async () => undefined),
}));

import { showGlobalNotification } from '@/components/UnifiedNotification';
import { reloadSkills } from '@/features/chat/skills';
import { SkillTapBrowser } from '../SkillTapBrowser';

const sampleCard = {
  slug: 'sonoscli',
  displayName: 'Sonoscli',
  summary: 'Control Sonos speakers',
  version: '1.0.0',
  downloads: 1000,
  ownerHandle: 'steipete',
  stars: 10,
  verify: {
    ok: true,
    decision: 'pass',
    reasons: [],
    slug: 'sonoscli',
    version: '1.0.0',
    securityStatus: 'clean',
    securityPassed: true,
    publisherHandle: 'steipete',
    publisherDisplayName: 'Peter',
  },
};

const sampleScan = {
  skill_id: 'sonoscli',
  path: '/tmp/skills/sonoscli',
  files_extracted: 2,
  scripts_count: 0,
  references_count: 0,
  allowed_tools_count: 0,
  package_sha256: 'a'.repeat(64),
  risk_level: 'low',
  risk_signals: [] as string[],
};

describe('SkillTapBrowser SkillMarket tab', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    vi.mocked(showGlobalNotification).mockClear();
    vi.mocked(reloadSkills).mockClear();
  });

  it('loads trending with nonSuspiciousOnly=true by default and shows verify badge', async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'skill_market_search') {
        expect(args).toMatchObject({
          nonSuspiciousOnly: true,
          sort: 'trending',
        });
        return { mode: 'list', items: [sampleCard] };
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    render(<SkillTapBrowser onClose={() => undefined} />);

    fireEvent.click(screen.getByTestId('skill-tap-tab-market'));

    await waitFor(() => {
      expect(screen.getByTestId('skill-market-card-sonoscli')).toBeInTheDocument();
    });

    expect(screen.getByText(/skills:tap.market.verify_ok/)).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith(
      'skill_market_search',
      expect.objectContaining({ nonSuspiciousOnly: true }),
    );
  });

  it('runs verify → download+scan → confirm → install with expected invoke args', async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'skill_market_search') {
        return { mode: 'list', items: [sampleCard] };
      }
      if (cmd === 'skill_market_verify') {
        expect(args).toEqual({ slug: 'sonoscli', version: '1.0.0' });
        return sampleCard.verify;
      }
      if (cmd === 'skill_market_download_and_scan') {
        return {
          slug: 'sonoscli',
          version: '1.0.0',
          provenance: 'skill_market:sonoscli@1.0.0',
          tempZipPath: '/tmp/sonoscli.zip',
          sourceKind: 'zip',
          scan: sampleScan,
          installed: Boolean(args?.install),
        };
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    render(<SkillTapBrowser onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId('skill-tap-tab-market'));

    await waitFor(() => {
      expect(screen.getByTestId('skill-market-install-sonoscli')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('skill-market-install-sonoscli'));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'skill_market_verify',
        { slug: 'sonoscli', version: '1.0.0' },
      );
      expect(invokeMock).toHaveBeenCalledWith(
        'skill_market_download_and_scan',
        expect.objectContaining({
          slug: 'sonoscli',
          version: '1.0.0',
          install: false,
        }),
      );
    });

    // 确认安装按钮（i18n mock 返回 key）
    const confirmBtn = await screen.findByRole('button', {
      name: 'skills:management.import_confirm_install',
    });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'skill_market_download_and_scan',
        expect.objectContaining({
          slug: 'sonoscli',
          version: '1.0.0',
          install: true,
          overwrite: false,
          expectedPackageSha256: sampleScan.package_sha256,
          tempZipPath: '/tmp/sonoscli.zip',
          declaredRiskLevel: sampleScan.risk_level,
        }),
      );
      expect(reloadSkills).toHaveBeenCalled();
    });
  });

  it('surfaces rate-limit errors from search as alert (not empty)', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'skill_market_search') {
        throw new Error('RATE_LIMITED: SkillMarket rate limit exceeded (Retry-After=30)');
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    render(<SkillTapBrowser onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId('skill-tap-tab-market'));

    await waitFor(() => {
      expect(screen.getByTestId('skill-market-rate-limited')).toHaveTextContent(
        'skills:tap.market.rate_limited',
      );
    });
    const el = screen.getByTestId('skill-market-rate-limited');
    expect(el).toHaveAttribute('role', 'alert');
    expect(el).toHaveAttribute('aria-live', 'assertive');
    expect(el).toHaveAttribute('data-skill-market-status', 'rate_limited');
    expect(screen.queryByTestId('skill-market-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('skill-market-results')).not.toBeInTheDocument();
  });

  it('shows empty as status (not alert) when search returns no items', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'skill_market_search') {
        return { mode: 'list', items: [] };
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    render(<SkillTapBrowser onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId('skill-tap-tab-market'));

    await waitFor(() => {
      expect(screen.getByTestId('skill-market-empty')).toHaveTextContent('skills:tap.market.empty');
    });
    const empty = screen.getByTestId('skill-market-empty');
    expect(empty).toHaveAttribute('role', 'status');
    expect(empty).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByTestId('skill-market-rate-limited')).not.toBeInTheDocument();
    expect(screen.queryByTestId('skill-market-network-error')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows network errors as alert distinct from empty and rate-limit', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'skill_market_search') {
        throw new Error('error sending request for url (http://127.0.0.1:9/): connection refused');
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    render(<SkillTapBrowser onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId('skill-tap-tab-market'));

    await waitFor(() => {
      expect(screen.getByTestId('skill-market-network-error')).toHaveTextContent(
        'skills:tap.market.network_error',
      );
    });
    const el = screen.getByTestId('skill-market-network-error');
    expect(el).toHaveAttribute('role', 'alert');
    expect(el).toHaveAttribute('data-skill-market-status', 'network_error');
    expect(screen.queryByTestId('skill-market-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('skill-market-rate-limited')).not.toBeInTheDocument();
  });

  it('success list uses results region and verify badge is not trust', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'skill_market_search') {
        return { mode: 'list', items: [sampleCard] };
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    render(<SkillTapBrowser onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId('skill-tap-tab-market'));

    await waitFor(() => {
      expect(screen.getByTestId('skill-market-results')).toBeInTheDocument();
    });
    expect(screen.getByTestId('skill-market-card-sonoscli')).toHaveAttribute('role', 'listitem');
    const badge = screen.getByTestId('skill-market-verify-badge');
    expect(badge).toHaveAttribute('data-verify-kind', 'ok');
    expect(badge.getAttribute('aria-label') ?? '').toMatch(/verify_not_trust_hint/);
    expect(screen.queryByTestId('skill-market-empty')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows loading status while SkillMarket search is in flight', async () => {
    let resolveSearch: ((value: unknown) => void) | undefined;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'skill_market_search') {
        return new Promise((resolve) => {
          resolveSearch = resolve;
        });
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    render(<SkillTapBrowser onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId('skill-tap-tab-market'));

    expect(await screen.findByTestId('skill-market-loading')).toHaveAttribute('role', 'status');
    expect(screen.getByTestId('skill-market-search-input')).toHaveAttribute(
      'aria-label',
      'skills:tap.market.search_placeholder',
    );

    resolveSearch?.({ mode: 'list', items: [sampleCard] });
    await waitFor(() => {
      expect(screen.queryByTestId('skill-market-loading')).not.toBeInTheDocument();
      expect(screen.getByTestId('skill-market-card-sonoscli')).toBeInTheDocument();
    });
  });

  it('can disable nonSuspiciousOnly and re-search', async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'skill_market_search') {
        calls.push(args);
        return { mode: 'list', items: [sampleCard] };
      }
      return {};
    });

    render(<SkillTapBrowser onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId('skill-tap-tab-market'));

    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(1));

    const checkbox = screen.getByTestId('skill-market-non-suspicious') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);

    await waitFor(() => {
      expect(calls.some((c) => c?.nonSuspiciousOnly === false)).toBe(true);
    });
  });

  it('ignores a stale search response after a newer query completes', async () => {
    let resolveInitial: ((value: unknown) => void) | undefined;
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd !== 'skill_market_search') return {};
      if (!args?.q) {
        return new Promise((resolve) => {
          resolveInitial = resolve;
        });
      }
      return {
        mode: 'search',
        items: [{ ...sampleCard, slug: 'new-result', displayName: 'New result' }],
      };
    });

    render(<SkillTapBrowser onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId('skill-tap-tab-market'));
    await screen.findByTestId('skill-market-loading');

    fireEvent.change(screen.getByTestId('skill-market-search-input'), { target: { value: 'new' } });
    fireEvent.keyDown(screen.getByTestId('skill-market-search-input'), { key: 'Enter' });
    await screen.findByTestId('skill-market-card-new-result');

    resolveInitial?.({ mode: 'list', items: [sampleCard] });
    await waitFor(() => {
      expect(screen.getByTestId('skill-market-card-new-result')).toBeInTheDocument();
      expect(screen.queryByTestId('skill-market-card-sonoscli')).not.toBeInTheDocument();
    });
  });
});

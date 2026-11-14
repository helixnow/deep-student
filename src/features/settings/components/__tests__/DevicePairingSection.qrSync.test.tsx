import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodeQrCodeMatrix,
  extractPairingCodeFromText,
  QrCodeSvg,
  renderQrCodeSvgString,
} from '../../utils/qrCodeSvg';
import { DevicePairingSection } from '../DevicePairingSection';

const mockInvoke = vi.fn(async (cmd: string) => {
  if (cmd === 'get_setting') return null;
  if (cmd === 'get_settings_by_prefix') return [];
  return null;
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: [string, unknown?]) => mockInvoke(...args),
}));

vi.mock('../../../../../host/plugins/sync/src/device-pairing', () => ({
  createPairingCode: vi.fn(async (_store: unknown, opts: { pin: string }) => ({
    pairingCode: `DSPAIR1:mock_payload_for_${opts.pin}`,
    summary: {
      cloudProvider: 'webdav',
      llmProviders: 2,
      includeSkills: true,
      includePlugins: true,
    },
  })),
  applyPairingCode: vi.fn(async () => ({
    summary: {
      cloudProvider: 'webdav',
      llmProviders: 2,
      includeSkills: true,
      includePlugins: true,
    },
  })),
}));

describe('QR Code encoder & DevicePairingSection workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('encodes UTF-8 payloads into valid ISO/IEC 18004 QR matrices with finder patterns', () => {
    const sample =
      'DSPAIR1:eyJ2IjoxLCJub25jZSI6InRlc3QiLCJjaXBoZXJ0ZXh0IjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoifQ==';
    const modules = encodeQrCodeMatrix(sample, 'M');
    const size = modules.length;
    const version = (size - 17) / 4;

    expect(version).toBeGreaterThanOrEqual(1);
    expect(version).toBeLessThanOrEqual(40);
    expect(size).toBe(17 + version * 4);

    // Top-left, top-right, bottom-left finder centers (row 3, col 3) must be dark
    expect(modules[3][3]).toBe(true);
    expect(modules[3][size - 4]).toBe(true);
    expect(modules[size - 4][3]).toBe(true);
  });

  it('renders QrCodeSvg and standalone SVG string with embedded DSPAIR1 metadata for offline file import', () => {
    const code = 'DSPAIR1:eyJ2IjoxfQ==';
    render(<QrCodeSvg value={code} ariaLabel="Test QR" />);

    const svg = screen.getByTestId('device-pairing-qr-svg');
    expect(svg).toHaveAttribute('data-pairing-code', code);
    expect(svg.querySelector('desc')?.textContent).toBe(code);

    const svgString = renderQrCodeSvgString(code);
    expect(extractPairingCodeFromText(svgString)).toBe(code);
  });

  it('generates a 6-digit PIN, exports pairing code, renders QR SVG, and triggers snapshot upload callback', async () => {
    const onRunSync = vi.fn();
    render(<DevicePairingSection onRunSync={onRunSync} cloudConfigured />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('get_setting', { key: 'sync.include_skills' });
    });

    // Click random 6-digit PIN generator
    fireEvent.click(screen.getByText('随机生成 6 位 PIN'));
    const pinInput = screen.getByPlaceholderText(
      '输入 6 位数字 PIN（或点击右侧随机生成）',
    ) as HTMLInputElement;
    expect(pinInput.value).toMatch(/^\d{6}$/);

    // Click generate QR button
    fireEvent.click(screen.getByTestId('generate-pairing-qr-btn'));

    expect(await screen.findByTestId('device-pairing-qr-panel')).toBeInTheDocument();
    expect(screen.getByTestId('device-pairing-qr-svg')).toHaveAttribute(
      'data-pairing-code',
      `DSPAIR1:mock_payload_for_${pinInput.value}`,
    );

    // Trigger one-click generate + push snapshot
    fireEvent.click(screen.getByText('生成并立即推送本机最新快照'));
    await waitFor(() => {
      expect(onRunSync).toHaveBeenCalledWith('upload');
    });
  });

  it('imports a pairing code in receive mode and triggers one-click pull sync', async () => {
    const onApplied = vi.fn();
    const onRunSync = vi.fn();
    render(
      <DevicePairingSection
        onApplied={onApplied}
        onRunSync={onRunSync}
        cloudConfigured
      />,
    );

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('get_setting', { key: 'sync.include_skills' });
    });

    // Switch to receive tab
    fireEvent.click(screen.getByRole('tab', { name: /新设备扫码/ }));

    fireEvent.change(screen.getByPlaceholderText('DSPAIR1:...'), {
      target: { value: 'DSPAIR1:eyJ2IjoxfQ==' },
    });
    fireEvent.change(screen.getByPlaceholderText('6 位数字 PIN'), {
      target: { value: '123456' },
    });

    fireEvent.click(screen.getByTestId('apply-pairing-code-btn'));

    await waitFor(() => {
      expect(onApplied).toHaveBeenCalledTimes(1);
    });

    // One-click bidirectional sync button appears after pairing succeeds
    const biSyncBtn = await screen.findByText('立即执行双向云同步');
    fireEvent.click(biSyncBtn);
    expect(onRunSync).toHaveBeenCalledWith('bidirectional');
  });

  it('mounts DevicePairingSection prominently in SyncTab and SyncSettingsSection and exposes quick entry in OverviewTab', () => {
    const syncTabSource = readFileSync(
      resolve(process.cwd(), 'src/features/settings/components/data-governance/SyncTab.tsx'),
      'utf-8',
    );
    const overviewTabSource = readFileSync(
      resolve(process.cwd(), 'src/features/settings/components/data-governance/OverviewTab.tsx'),
      'utf-8',
    );
    const syncSettingsSource = readFileSync(
      resolve(process.cwd(), 'src/features/settings/components/SyncSettingsSection.tsx'),
      'utf-8',
    );

    expect(syncTabSource).toContain('<DevicePairingSection');
    expect(syncSettingsSource).toContain('<DevicePairingSection');
    expect(overviewTabSource).toContain('overview-qr-sync-card');
  });
});

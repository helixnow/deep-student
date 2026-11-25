import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicePairingSection } from '../DevicePairingSection';

const mockInvoke = vi.hoisted(() =>
  vi.fn(async (cmd: string) => {
    if (cmd === 'get_setting') return null;
    if (cmd === 'get_settings_by_prefix') return [];
    return null;
  }),
);
const mockCopyText = vi.hoisted(() => vi.fn(async () => true));
const mockNotify = vi.hoisted(() => vi.fn());
const mockDecodePairingImage = vi.hoisted(() => vi.fn());
const mockDecodePairingFrame = vi.hoisted(() => vi.fn());

let currentLang = 'zh-CN';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: [string, unknown?]) => mockInvoke(...args),
}));

vi.mock('@/utils/clipboardUtils', () => ({
  copyTextToClipboard: (...args: [string]) => mockCopyText(...args),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: (...args: unknown[]) => mockNotify(...args),
}));

vi.mock('../../utils/decodePairingQr', () => ({
  decodePairingImage: (...args: [File]) => mockDecodePairingImage(...args),
  decodePairingFrame: (...args: unknown[]) => mockDecodePairingFrame(...args),
}));

vi.mock('../../../../../host/plugins/sync/src/device-pairing', () => ({
  createPairingCode: vi.fn(async (_store: unknown, opts: { pin: string }) => ({
    pairingCode: `DSPAIR1:generated_payload_${opts.pin}`,
    summary: {
      cloudProvider: 'webdav',
      llmProviders: 1,
      includeSkills: true,
      includePlugins: true,
    },
  })),
  applyPairingCode: vi.fn(async () => ({
    summary: {
      cloudProvider: 'webdav',
      llmProviders: 1,
      includeSkills: true,
      includePlugins: true,
    },
  })),
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: (ns?: string | string[]) => {
      const base = actual.useTranslation(ns);
      return {
        ...base,
        i18n: {
          ...base.i18n,
          get language() {
            return currentLang;
          },
        },
      };
    },
  };
});

describe('DevicePairingSection QR import fallback & one-click copy UX', () => {
  beforeEach(() => {
    currentLang = 'zh-CN';
    vi.clearAllMocks();
  });

  it('shows actionable alternatives and one-click focus into the manual pairing-code paste box when QR decode fails (zh-CN)', async () => {
    mockDecodePairingImage.mockResolvedValueOnce(null);

    render(<DevicePairingSection cloudConfigured />);
    await waitFor(() => expect(mockInvoke).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('tab', { name: /新设备扫码/ }));

    const fileInput = screen.getByTestId('import-qr-file-input');
    const badFile = new File([new Uint8Array([137, 80, 78, 71])], 'not-a-qr.png', {
      type: 'image/png',
    });
    fireEvent.change(fileInput, { target: { files: [badFile] } });

    const errorBanner = await screen.findByTestId('pairing-qr-import-error');
    expect(errorBanner).toHaveAttribute('role', 'alert');
    // Only one role="alert" banner should be rendered
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(errorBanner.textContent).toContain('复制配对文本码粘贴导入');
    expect(errorBanner.textContent).toContain('仅裁剪二维码区域');
    expect(errorBanner.textContent).toContain('6 位配对码');

    const fallbackPasteBtn = screen.getByTestId('pairing-qr-fallback-paste-btn');
    expect(fallbackPasteBtn).toHaveTextContent('改用粘贴配对码');
    expect(screen.getByTestId('pairing-qr-retry-import-btn')).toHaveTextContent('重新选择图片');

    const pasteBox = screen.getByTestId('pairing-code-paste-input') as HTMLTextAreaElement;
    expect(document.activeElement).not.toBe(pasteBox);

    fireEvent.click(fallbackPasteBtn);
    expect(document.activeElement).toBe(pasteBox);
    expect(pasteBox.className).toContain('border-primary');

    // Once the user pastes a pairing code, the stale QR import error clears cleanly
    fireEvent.change(pasteBox, { target: { value: 'DSPAIR1:pasted_code_123' } });
    expect(screen.queryByTestId('pairing-qr-import-error')).not.toBeInTheDocument();
  });

  it('shows localized English actionable fallback error and focuses paste input in en-US mode with zero leaked CJK', async () => {
    currentLang = 'en-US';
    mockDecodePairingImage.mockRejectedValueOnce(new Error('无法加载所选图片'));

    render(<DevicePairingSection cloudConfigured />);
    await waitFor(() => expect(mockInvoke).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('tab', { name: /新设备扫码|Scan/ }));

    const fileInput = screen.getByTestId('import-qr-file-input');
    const corruptFile = new File(['corrupt'], 'corrupt.png', { type: 'image/png' });
    fireEvent.change(fileInput, { target: { files: [corruptFile] } });

    const errorBanner = await screen.findByTestId('pairing-qr-import-error');
    expect(errorBanner).toHaveAttribute('role', 'alert');
    expect(errorBanner.textContent).toContain('Copy and paste the pairing text code below');
    expect(errorBanner.textContent).toContain('Crop tightly around the QR code area');
    expect(errorBanner.textContent).toContain('6-digit pairing PIN');

    const fallbackBtn = screen.getByTestId('pairing-qr-fallback-paste-btn');
    expect(fallbackBtn).toHaveTextContent('Paste pairing code instead');
    expect(fallbackBtn.textContent).not.toMatch(/[\u4e00-\u9fff]/);
    expect(screen.getByTestId('pairing-qr-retry-import-btn')).toHaveTextContent('Choose another image');

    const pasteBox = screen.getByTestId('pairing-code-paste-input');
    fireEvent.click(fallbackBtn);
    expect(document.activeElement).toBe(pasteBox);
  });

  it('populates the pairing code and focuses the 6-digit PIN field when QR screenshot import succeeds', async () => {
    mockDecodePairingImage.mockResolvedValueOnce('DSPAIR1:decoded_from_screenshot_999');

    render(<DevicePairingSection cloudConfigured />);
    await waitFor(() => expect(mockInvoke).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('tab', { name: /新设备扫码/ }));

    const fileInput = screen.getByTestId('import-qr-file-input');
    const screenshotFile = new File([new Uint8Array([1, 2, 3])], 'desktop-screenshot.png', {
      type: 'image/png',
    });
    fireEvent.change(fileInput, { target: { files: [screenshotFile] } });

    await waitFor(() => {
      expect(screen.getByTestId('pairing-code-paste-input')).toHaveValue(
        'DSPAIR1:decoded_from_screenshot_999',
      );
    });
    expect(screen.queryByTestId('pairing-qr-import-error')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByPlaceholderText('6 位数字 PIN'));
  });

  it('exposes a prominent one-click "复制配对码" button right beside the generated QR code on the sender side', async () => {
    render(<DevicePairingSection cloudConfigured />);
    await waitFor(() => expect(mockInvoke).toHaveBeenCalled());

    const pinInput = screen.getByPlaceholderText('输入 6 位数字 PIN（或点击右侧随机生成）');
    fireEvent.change(pinInput, { target: { value: '654321' } });
    fireEvent.click(screen.getByTestId('generate-pairing-qr-btn'));

    const qrPanel = await screen.findByTestId('device-pairing-qr-panel');
    const copyBtn = screen.getByTestId('copy-pairing-code-btn');
    const downloadBtn = screen.getByTestId('download-pairing-qr-btn');
    const codeOutput = screen.getByTestId('device-pairing-code-output');

    expect(qrPanel).toContainElement(copyBtn);
    expect(copyBtn).toHaveTextContent('复制配对码');
    // Copy button sits directly next to the QR code & download button, BEFORE the long code textarea
    expect(
      copyBtn.compareDocumentPosition(codeOutput) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(copyBtn.parentElement).toBe(downloadBtn.parentElement);

    fireEvent.click(copyBtn);
    await waitFor(() => {
      expect(mockCopyText).toHaveBeenCalledWith('DSPAIR1:generated_payload_654321');
    });
    expect(mockNotify).toHaveBeenCalledWith('success', expect.stringContaining('配对码已复制'));
  });
});

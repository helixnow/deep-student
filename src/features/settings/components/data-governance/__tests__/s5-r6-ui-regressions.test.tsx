import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  formatFriendlySyncError,
  localizeBackendErrorText,
} from '../localizeCloudError';
import { Checkbox } from '@/components/ui/shad/Checkbox';

const mockCloudApi = vi.hoisted(() => ({
  CLOUD_STORAGE_SSOT_MIGRATED_STORAGE_KEY: 'cloud_storage.ssot_migrated',
  DEFAULT_CLOUD_SYNC_ROOT: 'deep-student-sync',
  resolveCloudStorageConfig: vi.fn(async () => null),
  loadStoredCloudStorageConfigSafe: vi.fn(() => null),
  getCredentialStatus: vi.fn(async () => ({
    webdavPasswordConfigured: false,
    s3SecretAccessKeyConfigured: false,
    ftpPasswordConfigured: false,
    encryptionPasswordConfigured: false,
  })),
  publishCloudConfig: vi.fn(async (config: any) => ({
    config: {
      provider: config.provider,
      webdav: config.webdav ? { endpoint: config.webdav.endpoint, username: config.webdav.username } : undefined,
      root: config.root,
      allow_insecure: config.allowInsecure ?? false,
    },
  })),
  getSyncStatus: vi.fn(async () => ({ connected: true })),
  listVersions: vi.fn(async () => []),
  getPlatformStorageCapabilities: vi.fn(async () => ({ ftpSupported: true, s3Supported: true })),
  getCloudStorageErrorCode: vi.fn(() => undefined),
  getCloudEncryptionErrorI18nKey: vi.fn(() => undefined),
  getCloudPlatformErrorI18nKey: vi.fn(() => undefined),
  isExplicitCloudEncryptionPasswordTooShort: vi.fn(() => false),
  toSafeCloudStorageConfig: vi.fn((c: any) => c),
}));

vi.mock('@/utils/cloudStorageApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/cloudStorageApi')>()),
  ...mockCloudApi,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => null),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));

const stableT = (key: string, opts?: Record<string, unknown> | string) => {
  if (typeof opts === 'string') return opts;
  if (opts && typeof opts.defaultValue === 'string') return opts.defaultValue;
  return key;
};
const stableTranslation = { t: stableT, i18n: { language: 'zh-CN' } };

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => stableTranslation,
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

import { CloudStorageSection } from '../../CloudStorageSection';

describe('Round 6 S5-08 & S5-18 UI regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('S5-08: formatFriendlySyncError & localizeBackendErrorText strip stack traces, HTML error bodies, and internal codes', () => {
    const t = (_key: string, opts?: Record<string, unknown>) =>
      typeof opts?.defaultValue === 'string' ? opts.defaultValue : _key;

    const verbose503 =
      'Error: 双向同步失败: 上传同步失败（批次 1/1）: WebDAV PUT 请求失败（已重试 3 次）: WebDAV PUT sync/changes/a.zst 失败: HTTP 503 Service Unavailable；服务器详情: <html><body>503</body></html>\n    at WebDavStorage.requestWithPath (/app/webdav.ts:238:11)\n    at async uploadEnrichedChanges (/app/upload.ts:53:5)';

    const zhMsg = formatFriendlySyncError(verbose503, t, 'zh-CN');
    expect(zhMsg).toContain('HTTP 503');
    expect(zhMsg).not.toContain('at WebDavStorage');
    expect(zhMsg).not.toContain('<html>');
    expect(zhMsg).not.toContain('sync/changes/a.zst');

    const enMsg = formatFriendlySyncError(verbose503, t, 'en-US');
    expect(enMsg).toContain('HTTP 503');
    expect(enMsg).not.toContain('at WebDavStorage');
    expect(enMsg).not.toMatch(/[\u4e00-\u9fff]/);

    const leaseSelfRaw =
      '[E_SYNC_LEASE_HELD_SELF] 本机（dev-123）上一次同步没有正常结束，云端遗留的同步租约尚未过期（预计 2026-11-25T10:00:00Z 到期）。';
    const leaseMsg = formatFriendlySyncError(leaseSelfRaw, t, 'zh-CN');
    expect(leaseMsg).not.toContain('[E_SYNC_LEASE_HELD_SELF]');
    expect(leaseMsg).not.toContain('dev-123');

    const rawStack = 'TypeError: fetch failed\n    at Object.fetch (node:internal/deps/undici:1:1)';
    const cleanStackZh = localizeBackendErrorText(rawStack, 'zh-CN');
    expect(cleanStackZh).not.toContain('at Object.fetch');
    expect(cleanStackZh).toContain('网络连接不可用');
  });

  it('S5-18: WebDAV password renders masked (type="password") by default, toggles via accessible eye button, and resets to masked & cleared after save', async () => {
    render(<CloudStorageSection />);

    const endpointInput = await screen.findByPlaceholderText('cloudStorage:webdav.endpointPlaceholder');
    const userInput = screen.getByPlaceholderText('cloudStorage:webdav.usernamePlaceholder');
    const pwdInput = screen.getByLabelText('cloudStorage:webdav.password') as HTMLInputElement;

    // Masked by default before typing
    expect(pwdInput.type).toBe('password');

    // Accessible show/hide eye toggle is always present
    const toggleBtn = screen.getByRole('button', { name: 'common:securePassword.showPassword' });
    expect(toggleBtn).toHaveAttribute('aria-pressed', 'false');

    // Still masked while typing
    fireEvent.change(endpointInput, { target: { value: 'https://dav.example.com/dav/' } });
    fireEvent.change(userInput, { target: { value: 'student@example.com' } });
    fireEvent.change(pwdInput, { target: { value: 'my-app-secret-123' } });
    expect(pwdInput.type).toBe('password');

    // Eye toggle reveals plaintext, then hides again
    fireEvent.click(toggleBtn);
    expect(pwdInput.type).toBe('text');
    expect(screen.getByRole('button', { name: 'common:securePassword.hidePassword' })).toHaveAttribute('aria-pressed', 'true');

    // Saving resets visibility to masked AND clears plaintext password from the DOM input
    fireEvent.click(screen.getByRole('button', { name: 'cloudStorage:actions.save' }));
    await waitFor(() => {
      expect(mockCloudApi.publishCloudConfig).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(pwdInput.type).toBe('password');
      expect(pwdInput.value).toBe('');
    });
  });

  it('S5-18: Checkbox applies high-contrast dark-mode border & background classes when unchecked', () => {
    render(<Checkbox aria-label="Include AI API keys" checked={false} />);
    const cb = screen.getByRole('checkbox', { name: 'Include AI API keys' });
    expect(cb.className).toContain('dark:border-muted-foreground/85');
    expect(cb.className).toContain('border-muted-foreground/65');
    expect(cb.className).not.toContain('border-border/40');
    expect(cb.className).not.toContain('bg-transparent');
  });
});

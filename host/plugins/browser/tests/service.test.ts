import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHook } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { agentAutomationSupported, browserErrorMessage } from '../src/command-result.ts';
import { BrowserSession, USER_TAKEOVER_BLOCK_SECS } from '../src/session.ts';
import {
  MAX_BROWSER_DOWNLOAD_BYTES, MAX_BROWSER_TASK_DOWNLOAD_BYTES, MAX_SURFACE_OCCLUSIONS,
  PendingNavigation, TRUSTED_CONTENT_INPUT_KINDS, TrustedContentInputCapability,
  applyPendingNavigation, assertSettingsGatesOpen, contentLabel, downloadOwnerForSession,
  effectiveAllowInsecureHttp, hashDownloadFileBounded, isBrowserChildGateEnabled, isTruthy,
  isWorkbenchModeEnabled, physicalSurfaceBounds, physicalSurfaceOcclusions, releaseTaskDownloadReservation,
  requireLiveSurfaceSession, rollbackPendingNavigation, sanitizeDownloadFilename,
  taskDownloadBudgetAvailable, updateReusedDownloadOwner,
  type PhysicalRect, type SurfaceResult,
} from '../src/service.ts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function tempdir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'browser-service-'));
  directories.push(directory);
  return directory;
}
function unwrap<T>(result: SurfaceResult<T>): T {
  if (!result.ok) throw new Error(browserErrorMessage(result.error));
  return result.value;
}
function session(id = 'bs_active', url = 'https://example.com/'): BrowserSession {
  return new BrowserSession(id, url, '/tmp/browser');
}

describe('crates/dstu-browser/src/browser/service.rs::tests', () => {
  it('truthy_parsing', () => {
    expect(isTruthy('true')).toBe(true);
    expect(isTruthy('TRUE')).toBe(true);
    expect(isTruthy('1')).toBe(true);
    expect(isTruthy('false')).toBe(false);
    expect(isTruthy('')).toBe(false);
  });

  it('assert_settings_gates_open_missing_workbench_defaults_enabled', () => {
    expect(assertSettingsGatesOpen(null, 'true')).toBeNull();
    expect(assertSettingsGatesOpen('', 'true')).toBeNull();
    expect(assertSettingsGatesOpen('  ', 'true')).toBeNull();
    expect(assertSettingsGatesOpen('1', 'true')).toBeNull();
    expect(assertSettingsGatesOpen('FALSE', 'true')).toBeNull();

    expect(assertSettingsGatesOpen('false', 'true')).toBe('browser disabled: desktop.workbenchMode is off');
    expect(assertSettingsGatesOpen('  false  ', 'true')).not.toBeNull();

    expect(assertSettingsGatesOpen(null, null)).toBe('browser disabled: desktop.workbenchBrowserEnabled is off');
    expect(assertSettingsGatesOpen('true', 'false')).not.toBeNull();
    expect(assertSettingsGatesOpen('true', 'true')).toBeNull();
  });

  it('workbench_mode_enabled_only_explicit_false_closes', () => {
    expect(isWorkbenchModeEnabled(null)).toBe(true);
    expect(isWorkbenchModeEnabled('true')).toBe(true);
    expect(isWorkbenchModeEnabled('false')).toBe(false);
    expect(isBrowserChildGateEnabled('true')).toBe(true);
    expect(isBrowserChildGateEnabled(null)).toBe(false);
    expect(isBrowserChildGateEnabled('false')).toBe(false);
  });

  it('content_label_is_fixed', () => {
    expect(contentLabel()).toBe('browser-content');
  });

  it('agent_automation_capability_matches_platform', () => {
    expect(agentAutomationSupported('darwin')).toBe(true);
    expect(agentAutomationSupported('win32')).toBe(true);
    expect(agentAutomationSupported('linux')).toBe(false);
  });

  it('http_allowance_depends_on_control_mode', () => {
    expect(effectiveAllowInsecureHttp(false, false)).toBe(true);
    expect(effectiveAllowInsecureHttp(true, false)).toBe(true);
    expect(effectiveAllowInsecureHttp(false, true)).toBe(false);
    expect(effectiveAllowInsecureHttp(true, true)).toBe(true);
  });

  it('surface_bounds_scale_css_coordinates_to_physical_pixels', () => {
    const rect = unwrap(physicalSurfaceBounds({
      x: 10, y: 20, width: 100, height: 50, viewportWidth: 500, viewportHeight: 400,
    }, { width: 1000, height: 800 }));
    expect(rect).toEqual(rectAt(20, 40, 200, 100));
  });

  it('surface_bounds_preserve_partially_overflowing_frames', () => {
    const viewport = { width: 1000, height: 800 };
    const base = { x: 10, y: 20, width: 100, height: 50, viewportWidth: 500, viewportHeight: 400 };
    const cases: [Parameters<typeof physicalSurfaceBounds>[0], PhysicalRect][] = [
      [{ ...base, x: -25 }, rectAt(-50, 40, 200, 100)],
      [{ ...base, x: 450 }, rectAt(900, 40, 200, 100)],
      [{ ...base, y: -10 }, rectAt(20, -20, 200, 100)],
      [{ ...base, y: 375 }, rectAt(20, 750, 200, 100)],
      [{ ...base, x: -25, y: -10, width: 600, height: 500 }, rectAt(-50, -20, 1200, 1000)],
    ];
    for (const [bounds, expected] of cases) {
      expect(unwrap(physicalSurfaceBounds(bounds, viewport))).toEqual(expected);
    }
  });

  it('surface_bounds_reject_non_finite_empty_and_offscreen_values', () => {
    const viewport = { width: 1000, height: 800 };
    const valid = { x: 10, y: 20, width: 100, height: 50, viewportWidth: 500, viewportHeight: 400 };
    for (const bounds of [
      { ...valid, x: Number.NaN },
      { ...valid, x: Number.MAX_VALUE, width: Number.MAX_VALUE },
      { ...valid, width: 0 },
      { ...valid, x: -100, width: 100 },
      { ...valid, x: -101, width: 100 },
      { ...valid, x: 500 },
      { ...valid, y: -50, height: 50 },
      { ...valid, y: -51, height: 50 },
      { ...valid, y: 400 },
    ]) {
      expect(physicalSurfaceBounds(bounds, viewport).ok).toBe(false);
    }
  });

  it('surface_bounds_round_outward_with_nonuniform_scale', () => {
    const rect = unwrap(physicalSurfaceBounds({
      x: -0.2, y: -0.2, width: 100.4, height: 50.4, viewportWidth: 400, viewportHeight: 200,
    }, { width: 1000, height: 300 }));
    expect(rect).toEqual(rectAt(-1, -1, 252, 77));
  });

  it('surface_bounds_reject_unrepresentable_physical_frames', () => {
    const scaleOne = { width: 1000, height: 800 };
    const base = { x: 0, y: 0, width: 100, height: 100, viewportWidth: 1000, viewportHeight: 800 };
    const cases: [Parameters<typeof physicalSurfaceBounds>[0], Parameters<typeof physicalSurfaceBounds>[1]][] = [
      [{ ...base, x: -2147483649, width: 2147483650 }, scaleOne],
      [{ ...base, x: 999, width: 2147483647 }, scaleOne],
      [{ ...base, x: -1073741824, width: 2147483648 }, scaleOne],
      [{ ...base, width: 1, height: 1, viewportWidth: 1, viewportHeight: 1 }, { width: 4294967295, height: 1 }],
    ];
    for (const [bounds, viewport] of cases) {
      expect(physicalSurfaceBounds(bounds, viewport).ok).toBe(false);
    }
  });

  it('surface_occlusions_clip_to_the_native_viewport', () => {
    const rects = unwrap(physicalSurfaceOcclusions([
      { x: -20, y: 375, width: 50, height: 100 },
      { x: 600, y: 20, width: 50, height: 50 },
    ], 500, 400, { width: 1000, height: 800 }));
    expect(rects.length).toBe(1);
    expect(rects[0]).toEqual(rectAt(0, 750, 60, 50));
  });

  it('surface_occlusions_merge_after_physical_rounding', () => {
    const rects = unwrap(physicalSurfaceOcclusions([
      { x: 0.1, y: 0, width: 10, height: 10 },
      { x: 10.1, y: 0, width: 10, height: 10 },
    ], 100, 100, { width: 100, height: 100 }));
    expect(rects.length).toBe(1);
    expect(rects[0]).toEqual(rectAt(0, 0, 21, 10));
  });

  it('surface_occlusions_reject_invalid_input_and_excessive_count', () => {
    const viewport = { width: 1000, height: 800 };
    expect(physicalSurfaceOcclusions([
      { x: Number.NaN, y: 0, width: 10, height: 10 },
    ], 500, 400, viewport).ok).toBe(false);
    const repeated = { x: 0, y: 0, width: 10, height: 10 };
    expect(physicalSurfaceOcclusions(
      new Array(MAX_SURFACE_OCCLUSIONS + 1).fill(repeated), 500, 400, viewport,
    ).ok).toBe(false);
  });

  it('surface_session_guard_rejects_stale_and_closed_sessions', () => {
    const active = session('bs_active');
    expect(requireLiveSurfaceSession(active, 'bs_active').ok).toBe(true);
    expect(requireLiveSurfaceSession(active, 'bs_stale').ok).toBe(false);

    active.markClosed();
    expect(requireLiveSurfaceSession(active, 'bs_active').ok).toBe(false);
    expect(requireLiveSurfaceSession(null, 'bs_active').ok).toBe(false);
  });

  it('trusted_input_capability_is_session_bound_and_128_bit', () => {
    const capability = TrustedContentInputCapability.generate('bs_active');
    const encoded = capability.encodedNonce();

    expect(encoded.length).toBe(32);
    expect(Buffer.from(encoded, 'hex').length).toBe(16);
    expect(capability.matches('bs_active', encoded)).toBe(true);
    expect(capability.matches('bs_replaced', encoded)).toBe(false);
    expect(capability.matches('bs_active', '0000000000000000000000000000000g')).toBe(false);

    const wrong = Buffer.from(encoded, 'hex');
    wrong[0] = wrong[0] === 0x30 ? 0x31 : 0x30;
    expect(capability.matches('bs_active', wrong.toString('hex'))).toBe(false);
  });

  it('trusted_input_kinds_exclude_script_chosen_values', () => {
    for (const kind of ['pointerdown', 'keydown', 'compositionstart', 'wheel']) {
      expect(TRUSTED_CONTENT_INPUT_KINDS.includes(kind)).toBe(true);
    }
    expect(TRUSTED_CONTENT_INPUT_KINDS.includes('click')).toBe(false);
    expect(TRUSTED_CONTENT_INPUT_KINDS.includes('agent_claim')).toBe(false);
  });

  it('direct_policy_rejection_never_commits_requested_url', () => {
    const active = session('bs_navigation', 'https://allowed.example/');
    active.markLoaded();
    const attempt = new PendingNavigation(1, active.id, active.clone(), 'push', {
      url: 'http://blocked.example/', reason: 'blocked',
    });

    expect(applyPendingNavigation(active, attempt, 'http://blocked.example/', false).ok).toBe(false);
    expect(active.url).toBe('https://allowed.example/');
    expect(active.history.length).toBe(1);
  });

  it('blocked_redirect_restores_current_url_and_forward_history', () => {
    const active = session('bs_redirect', 'https://a.example/');
    active.pushUrl('https://b.example/', null);
    active.goBack();
    active.markLoaded();
    const attempt = new PendingNavigation(2, active.id, active.clone(), 'push', null);

    expect(applyPendingNavigation(active, attempt, 'https://c.example/', false).ok).toBe(true);
    attempt.markBlocked('http://blocked-redirect.example/', 'blocked redirect');
    rollbackPendingNavigation(active, attempt);

    expect(active.url).toBe('https://a.example/');
    expect(active.history.length).toBe(2);
    expect(active.canGoForward()).toBe(true);
    expect(active.history[1]!.url).toBe('https://b.example/');
  });

  it('download_filename_sanitization_removes_path_control', () => {
    expect(sanitizeDownloadFilename('../../report:final.xlsx')).toBe('_.._report_final.xlsx');
    expect(sanitizeDownloadFilename('...')).toBe('download.bin');
  });

  it('download_hash_reports_sha256_and_size', async () => {
    const directory = tempdir();
    const path = join(directory, 'download.bin');
    writeFileSync(path, 'browser-download');
    const result = await hashDownloadFileBounded(path, 1024);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sha256).toBe('60447d549d1703e0f1a62a71399052593d9d6e461697ee6e20b82f5877e3df5b');
    expect(result.size).toBe(16);
  });

  it('L19-V2-05 hashes in a real native worker without silently falling back to the Host', async () => {
    const path = join(tempdir(), 'worker-download.bin');
    const bytes = Buffer.alloc(8 * 64 * 1024, 0x5a);
    writeFileSync(path, bytes);
    const warnings: string[] = [];
    let workers = 0;
    // Observe Node's actual worker resource; do not replace the worker or digest implementation.
    const hook = createHook({ init(_id, type) { if (type === 'WORKER') workers += 1; } });
    hook.enable();
    try {
      const result = await hashDownloadFileBounded(path, bytes.length, message => warnings.push(message));
      expect(result).toEqual({ ok: true, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
      expect(workers).toBe(1);
      expect(warnings).toEqual([]);
    } finally { hook.disable(); }
  });

  it('L19-V2-05 reports an open failure from the worker, not as a worker-unavailable fallback', async () => {
    const warnings: string[] = [];
    const result = await hashDownloadFileBounded(join(tempdir(), 'missing.bin'), 1024,
      message => warnings.push(message));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^open downloaded file: /u);
    expect(warnings).toEqual([]);
  });

  it('reused_session_download_owner_tracks_current_caller', () => {
    const active = new BrowserSession('bs_reused', 'https://example.com', '/tmp/profile', 'chat-old');
    updateReusedDownloadOwner(active, true, 'chat-new');
    active.controlMode = 'agent';
    expect(active.chatSessionId).toBe('chat-new');
    expect(downloadOwnerForSession(active, 'bs_reused')).toEqual({ ok: true, owner: 'chat-new' });
    expect(downloadOwnerForSession(active, 'bs_stale').ok).toBe(false);
    active.chatSessionId = null;
    expect(downloadOwnerForSession(active, 'bs_reused').ok).toBe(false);
    updateReusedDownloadOwner(active, false, 'ignored');
    active.controlMode = 'user';
    expect(active.chatSessionId).toBeNull();
    expect(downloadOwnerForSession(active, 'bs_reused')).toEqual({ ok: true, owner: null });
  });

  it('download_budgets_reserve_pending_and_count_completed_bytes', () => {
    expect(taskDownloadBudgetAvailable(0, 3 * MAX_BROWSER_DOWNLOAD_BYTES)).toBe(true);
    expect(taskDownloadBudgetAvailable(0, 4 * MAX_BROWSER_DOWNLOAD_BYTES)).toBe(false);
    expect(taskDownloadBudgetAvailable(
      MAX_BROWSER_TASK_DOWNLOAD_BYTES - MAX_BROWSER_DOWNLOAD_BYTES + 1, 0,
    )).toBe(false);

    const reservations = new Map([['chat-a', 2 * MAX_BROWSER_DOWNLOAD_BYTES]]);
    releaseTaskDownloadReservation(reservations, 'chat-a');
    expect(reservations.get('chat-a')).toBe(MAX_BROWSER_DOWNLOAD_BYTES);
    releaseTaskDownloadReservation(reservations, 'chat-a');
    expect(reservations.has('chat-a')).toBe(false);
  });

  it('bounded_download_hash_rejects_oversized_file', async () => {
    const directory = tempdir();
    const path = join(directory, 'oversized.bin');
    writeFileSync(path, Buffer.alloc(1025));
    const result = await hashDownloadFileBounded(path, 1024);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('download exceeds per-file byte limit');
  });
});

function rectAt(x: number, y: number, width: number, height: number): PhysicalRect {
  return { x, y, width, height };
}

describe('browser service helpers beyond the Rust unit tests', () => {
  it('keeps downloads bounded and filenames control-free', () => {
    expect(USER_TAKEOVER_BLOCK_SECS).toBe(15);
    expect(sanitizeDownloadFilename('a\u0000b\u007fc.txt')).toBe('a_b_c.txt');
    expect(sanitizeDownloadFilename('  report.pdf  ')).toBe('report.pdf');
    const long = sanitizeDownloadFilename('x'.repeat(200));
    expect(long.length).toBe(180);
  });
});

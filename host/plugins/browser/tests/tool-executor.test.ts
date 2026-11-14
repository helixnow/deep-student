import { describe, expect, it } from 'vitest';
import { HEADLESS_ALLOWED_TOOLS } from '../../agent-workspace/api.ts';
import { LEGACY_HEADLESS_ALLOWED_TOOLS } from '../../agent-orchestration/api.ts';
import {
  BROWSER_PASSWORD_BLOCKED, annotateControlClaim, browserToolConcurrency, browserToolSensitivity,
  browserUserTakeoverError, isBrowserTool, isMutatingBrowserTool, isPasswordBlockedBridgeError,
  isUploadRootKind, mapBrowserToolBridgeError, mimeTypeForName,
} from '../src/tool-executor.ts';
import type { BridgeError, JsonValue } from '../src/command-result.ts';

describe('src/chat_v2/tools/browser_executor.rs::tests', () => {
  it('can_handle_browser_tools', () => {
    expect(isBrowserTool('builtin-browser_open')).toBe(true);
    expect(isBrowserTool('browser_navigate')).toBe(true);
    expect(isBrowserTool('builtin-browser_snapshot')).toBe(true);
    expect(isBrowserTool('builtin-browser_screenshot')).toBe(true);
    expect(isBrowserTool('browser_click')).toBe(true);
    expect(isBrowserTool('builtin-browser_type')).toBe(true);
    expect(isBrowserTool('builtin-browser_file_upload')).toBe(true);
    expect(isBrowserTool('builtin-browser_downloads')).toBe(true);
    expect(isBrowserTool('browser_scroll')).toBe(true);
    expect(isBrowserTool('builtin-browser_back')).toBe(true);
    expect(isBrowserTool('browser_close')).toBe(true);
    expect(isBrowserTool('builtin-web_fetch')).toBe(false);
    expect(isBrowserTool('chatanki_run')).toBe(false);
  });

  it('sensitivity_matrix', () => {
    expect(browserToolSensitivity('builtin-browser_open')).toBe('high');
    expect(browserToolSensitivity('browser_navigate')).toBe('medium');
    expect(browserToolSensitivity('browser_click')).toBe('medium');
    expect(browserToolSensitivity('browser_type')).toBe('medium');
    expect(browserToolSensitivity('browser_file_upload')).toBe('high');
    expect(browserToolSensitivity('browser_downloads')).toBe('low');
    expect(browserToolSensitivity('browser_snapshot')).toBe('low');
    expect(browserToolSensitivity('browser_screenshot')).toBe('low');
    expect(browserToolSensitivity('browser_scroll')).toBe('low');
    expect(browserToolSensitivity('browser_back')).toBe('low');
    expect(browserToolSensitivity('browser_close')).toBe('medium');
  });

  it('concurrency_is_serial', () => {
    expect(browserToolConcurrency('browser_snapshot')).toBe('serial');
  });

  it('upload_root_allowlist_excludes_temp_and_skill_packages', () => {
    expect(isUploadRootKind('workspace')).toBe(true);
    expect(isUploadRootKind('authorized')).toBe(true);
    expect(isUploadRootKind('artifact')).toBe(true);
    expect(isUploadRootKind('temp')).toBe(false);
    expect(isUploadRootKind('skill_package')).toBe(false);
  });

  it('upload_mime_type_is_derived_from_safe_filename_only', () => {
    expect(mimeTypeForName('report.xlsx'))
      .toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(mimeTypeForName('unknown.bin')).toBe('application/octet-stream');
  });

  it('password_bridge_error_maps', () => {
    const error: BridgeError = {
      kind: 'Bridge',
      code: 'BLOCKED',
      message: 'password fields cannot be typed by agent bridge',
      details: { reason: 'password_field', ref: 'e1' },
    };
    expect(mapBrowserToolBridgeError(error)).toContain(BROWSER_PASSWORD_BLOCKED);
  });

  it('is_password_blocked_detects_reason', () => {
    expect(isPasswordBlockedBridgeError({
      kind: 'Bridge', code: 'BLOCKED', message: 'blocked',
      details: { reason: 'password_field' },
    })).toBe(true);
    expect(isPasswordBlockedBridgeError({
      kind: 'Bridge', code: 'BLOCKED', message: 'other',
      details: { reason: 'policy' },
    })).toBe(false);
  });

  it('mutating_tool_matrix', () => {
    expect(isMutatingBrowserTool('browser_open')).toBe(true);
    expect(isMutatingBrowserTool('browser_navigate')).toBe(true);
    expect(isMutatingBrowserTool('browser_click')).toBe(true);
    expect(isMutatingBrowserTool('browser_type')).toBe(true);
    expect(isMutatingBrowserTool('browser_scroll')).toBe(true);
    expect(isMutatingBrowserTool('browser_back')).toBe(true);
    expect(isMutatingBrowserTool('browser_close')).toBe(true);
    expect(isMutatingBrowserTool('browser_snapshot')).toBe(false);
    expect(isMutatingBrowserTool('browser_screenshot')).toBe(false);
    expect(isMutatingBrowserTool('browser_downloads')).toBe(false);
  });

  it('control_claim_annotation', () => {
    const plain: Record<string, JsonValue> = { ok: true };
    annotateControlClaim(plain, { claimedFromUser: false, reclaimedAfterUserTakeover: false });
    expect(plain).toEqual({ ok: true });

    const claimed: Record<string, JsonValue> = { ok: true };
    annotateControlClaim(claimed, { claimedFromUser: true, reclaimedAfterUserTakeover: false });
    expect(claimed.control_claimed_from_user).toBe(true);
    expect(claimed.control_notice).toBe('已从用户手中接管浏览器控制');
    expect(claimed.user_takeover_notice).toBeUndefined();

    const resumed: Record<string, JsonValue> = { ok: true };
    annotateControlClaim(resumed, { claimedFromUser: true, reclaimedAfterUserTakeover: true });
    expect(resumed.resumed_after_user_takeover).toBe(true);
    expect(String(resumed.user_takeover_notice)).toContain('接管冷却结束后');
  });

  it('not_in_headless_whitelist_names', () => {
    const names = [
      'builtin-browser_open',
      'builtin-browser_navigate',
      'builtin-browser_snapshot',
      'builtin-browser_click',
      'builtin-browser_type',
      'builtin-browser_scroll',
      'builtin-browser_back',
      'builtin-browser_close',
    ];
    for (const name of names) {
      expect(HEADLESS_ALLOWED_TOOLS).not.toContain(name);
      expect(LEGACY_HEADLESS_ALLOWED_TOOLS).not.toContain(name);
    }
  });

  it('user_takeover_err_is_structured_json', () => {
    const parsed = JSON.parse(browserUserTakeoverError()) as Record<string, JsonValue>;
    expect(parsed.code).toBe('USER_TAKEOVER');
    expect(parsed.hint).toBe('用户已接管浏览器，请询问用户或稍后再试');
    expect(parsed.retryable).toBe(true);
  });
});

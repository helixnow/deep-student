/**
 * 会话级 composer 草稿（sessionStorage）。
 *
 * 首条消息发送后 ChatContainer 会从 empty 布局切到 docked，InputBarV2 会 remount。
 * 若草稿仍留在 sessionStorage，新实例会把已发送正文写回输入框。
 * 因此发送路径必须同步清草稿，恢复时也要避开非 idle 会话。
 */

export function composerDraftStorageKey(sessionId: string | null | undefined): string | null {
  return sessionId ? `dstu.chatv2.draft.${sessionId}` : null;
}

export function readComposerDraft(sessionId: string | null | undefined): string | null {
  const key = composerDraftStorageKey(sessionId);
  if (!key) return null;
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeComposerDraft(sessionId: string | null | undefined, value: string): void {
  const key = composerDraftStorageKey(sessionId);
  if (!key) return;
  try {
    if (value) {
      sessionStorage.setItem(key, value);
    } else {
      sessionStorage.removeItem(key);
    }
  } catch {
    // 隐私模式等：草稿只是增强能力
  }
}

export function clearComposerDraft(sessionId: string | null | undefined): void {
  writeComposerDraft(sessionId, '');
}

/**
 * 仅在 idle 且输入框为空时恢复草稿。
 * streaming/sending 时若仍有草稿，视为发送后 remount 残留，直接丢弃。
 */
export function restoreComposerDraftIfSafe(
  sessionId: string | null | undefined,
  inputValue: string,
  sessionStatus: string,
): string | null {
  if (inputValue !== '') return null;
  const draft = readComposerDraft(sessionId);
  if (!draft) return null;
  if (sessionStatus !== 'idle') {
    clearComposerDraft(sessionId);
    return null;
  }
  return draft;
}

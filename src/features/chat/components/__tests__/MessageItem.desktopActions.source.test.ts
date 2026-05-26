import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const messageActionsSource = readFileSync(
  resolve(process.cwd(), 'src/features/chat/components/message/MessageActions.tsx'),
  'utf-8'
);

const messageItemSource = readFileSync(
  resolve(process.cwd(), 'src/features/chat/components/MessageItem.tsx'),
  'utf-8'
);

const messageListSource = readFileSync(
  resolve(process.cwd(), 'src/features/chat/components/MessageList.tsx'),
  'utf-8'
);

describe('MessageItem desktop actions source', () => {
  it('keeps the latest assistant footer fully visible and reveals historical assistant footers on hover', () => {
    expect(messageListSource).toContain('isLatest={messageIndex === messageOrder.length - 1}');
    expect(messageItemSource).toContain('isLatest?: boolean;');
    expect(messageItemSource).toContain('const showAssistantFooterAlways = !isUser && isLatest;');
    expect(messageItemSource).toContain("const assistantFooterClassName = showAssistantFooterAlways");
    expect(messageActionsSource).toContain('alwaysExpanded?: boolean;');
    expect(messageActionsSource).toContain('const showDesktopSecondaryActions = compactMobile || alwaysExpanded;');
    expect(messageActionsSource).toContain('const hasSecondaryActions = Boolean(');
    expect(messageActionsSource).toContain('const showOverflowMenu = compactMobile || hasSecondaryActions');
    expect(messageActionsSource).toContain('const showInlineCopyOnly = !compactMobile');
    expect(messageActionsSource).toContain('showDesktopSecondaryActions');
    expect(messageActionsSource).toContain('const desktopSecondaryActionsClassName = showDesktopSecondaryActions');
    expect(messageActionsSource).toContain('md:group-hover:opacity-100');
    expect(messageActionsSource).toContain('md:group-focus-within:opacity-100');
    expect(messageActionsSource).toContain('{showOverflowMenu && actionsMenu}');
    expect(messageItemSource).toContain('alwaysExpanded={showAssistantFooterAlways}');
  });

  it('collapses hidden desktop secondary actions so user copy stays visually close to the timestamp', () => {
    expect(messageActionsSource).toContain('md:w-0');
    expect(messageActionsSource).toContain('md:overflow-hidden');
    expect(messageActionsSource).toContain('md:pointer-events-none');
    expect(messageActionsSource).toContain('md:group-hover:w-auto');
    expect(messageActionsSource).toContain('md:group-focus-within:w-auto');
  });

  it('anchors desktop user copy to the message tail so hover actions grow away from the timestamp', () => {
    expect(messageItemSource).toContain('anchorCopyToEnd={isUser}');
    expect(messageActionsSource).toContain('anchorCopyToEnd?: boolean;');
    expect(messageActionsSource).toContain('const desktopCopyButton = showInlineCopyOnly ? (');
    expect(messageActionsSource).toContain('{!anchorCopyToEnd && desktopCopyButton}');
    expect(messageActionsSource).toContain('{anchorCopyToEnd && desktopCopyButton}');
  });
});

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const messageListPath = path.join(repoRoot, 'src/features/chat/components/MessageList.tsx');
const threadEmptyStateShellPath = path.join(repoRoot, 'src/features/chat/components/ui/ThreadEmptyStateShell.tsx');
const chatContainerPath = path.join(repoRoot, 'src/features/chat/components/ChatContainer.tsx');
const chatPagePath = path.join(repoRoot, 'src/features/chat/pages/ChatV2Page.tsx');
const oldWorkspaceLabel = ['当前工作区：', 'study-ui'].join('');
const oldWorkspaceKey = ['workspace', 'Label'].join('');
const oldWorkspaceHintKey = ['workspace', 'Hint'].join('');
const oldShowSuggestionsKey = ['show', 'Suggestions'].join('');
const oldWorkspaceHintText = [
  '把需求直接发到底部输入区。',
  '首屏保持安静，只保留当前工作区、主动作和足够的留白。',
].join('');

function readSource(absolutePath: string) {
  return existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : '';
}

describe('MessageList empty state source guards', () => {
  it('keeps the default new-session landing quiet and folds the group name into the primary action when provided', () => {
    const source = readSource(messageListPath);
    const emptyStateShellSource = readSource(threadEmptyStateShellPath);
    const emptyStateMatch = source.match(/if \(forceEmptyPreview \|\| messageOrder\.length === 0\) \{([\s\S]*?)return \(/);
    const emptyBlock = emptyStateMatch?.[1] ?? '';

    expect(emptyStateShellSource).toContain('data-slot="thread-empty-state"');
    expect(source).toContain('emptyStateGroupName?: string | null');
    expect(source).toContain('emptyStateGroupName = null');
    expect(source).toContain("t('messageList.empty.primaryAction'");
    expect(source).toContain("defaultValue: '今天想学点什么？'");
    expect(source).toContain("t('messageList.empty.primaryActionInGroup'");
    expect(source).toContain('groupName: emptyStateGroupName');
    expect(source).toContain("defaultValue: '在「{{groupName}}」里学点什么？'");
    expect(source).toContain('title={emptyStatePrimaryAction}');
    expect(emptyBlock).not.toContain('<p className="text-base text-muted-foreground">{emptyStateGroupName}</p>');

    expect(source).not.toContain(`t('chatV2:messageList.empty.${oldWorkspaceKey}'`);
    expect(source).not.toContain(`defaultValue: '${oldWorkspaceLabel}'`);
    expect(source).not.toContain(oldWorkspaceLabel);
    expect(source).not.toContain(`defaultValue: '${oldWorkspaceHintText}'`);
    expect(source).not.toContain("defaultValue: '查看建议起点'");
    expect(source).not.toContain('<Sparkles');
    expect(source).not.toContain('<NotionButton');
    expect(source).not.toContain(`messageList.empty.${oldWorkspaceHintKey}`);
    expect(source).not.toContain(`messageList.empty.${oldShowSuggestionsKey}`);
    expect(emptyBlock).not.toContain("const starterPrompt = t('messageList.empty.suggestion2');");
  });

  it('passes only real group names into the empty state and keeps ungrouped sessions generic', () => {
    const containerSource = readSource(chatContainerPath);
    const pageSource = readSource(chatPagePath);

    expect(containerSource).toContain('emptyStateGroupName?: string | null');
    expect(containerSource).toContain('emptyStateGroupName = null');
    expect(containerSource).toContain('const sessionGroupId = useStore(store, (s) => s.groupId);');
    expect(containerSource).toContain('const resolvedEmptyStateGroupName = emptyStateGroupName ??');
    expect(containerSource).toContain('groupCache.get(sessionGroupId)?.name');
    expect(containerSource).toContain('emptyStateGroupName={resolvedEmptyStateGroupName}');

    expect(pageSource).not.toContain('const ungroupedGroupName = t(');
    expect(pageSource).toContain('const currentSessionGroupName = currentSession?.groupId');
    expect(pageSource).toContain("groupNameMap.get(currentSession.groupId) ?? t('page.studySessions', '课题')");
    expect(pageSource).toContain("t('page.studySessions', '课题')");
    expect(pageSource).toContain('emptyStateGroupName={currentSessionGroupName}');
  });
});

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const messageListPath = path.join(repoRoot, 'src/features/chat/components/MessageList.tsx');
const threadEmptyStateShellPath = path.join(repoRoot, 'src/features/chat/components/ui/ThreadEmptyStateShell.tsx');
const chatContainerPath = path.join(repoRoot, 'src/features/chat/components/ChatContainer.tsx');
const chatPagePath = path.join(repoRoot, 'src/features/chat/pages/ChatV2Page.tsx');
const zhChatV2Path = path.join(repoRoot, 'src/locales/zh-CN/chatV2.json');
const enChatV2Path = path.join(repoRoot, 'src/locales/en-US/chatV2.json');
const oldWorkspaceLabel = ['当前工作区：', 'study-ui'].join('');
const oldWorkspaceKey = ['workspace', 'Label'].join('');
const oldWorkspaceHintKey = ['workspace', 'Hint'].join('');
const oldShowSuggestionsKey = ['show', 'Suggestions'].join('');
const oldWorkspaceHintText = [
  '把需求直接发到底部输入区。',
  '首屏保持安静，只保留当前工作区、主动作和足够的留白。',
].join('');

interface ChatV2Locale {
  messageList: {
    empty: {
      primaryAction: string;
      primaryActionInGroup: string;
      primaryActionVariants: string[];
      primaryActionInGroupVariants: string[];
    };
  };
}

function readSource(absolutePath: string) {
  return existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : '';
}

function readJson(absolutePath: string) {
  return JSON.parse(readSource(absolutePath)) as ChatV2Locale;
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
    expect(source).not.toContain("defaultValue: '今天想学点什么？'");
    expect(source).toContain("t('messageList.empty.primaryActionInGroup'");
    expect(source).toContain('groupName: emptyStateGroupName');
    expect(source).not.toContain("defaultValue: '在「{{groupName}}」里学点什么？'");
    expect(source).toContain('title={emptyStatePrimaryAction}');
    expect(emptyBlock).not.toContain('<p className="text-base text-muted-foreground">{emptyStateGroupName}</p>');

    expect(source).not.toContain(`t('chatV2:messageList.empty.${oldWorkspaceKey}'`);
    expect(source).not.toContain(`defaultValue: '${oldWorkspaceLabel}'`);
    expect(source).not.toContain(oldWorkspaceLabel);
    expect(source).not.toContain(`defaultValue: '${oldWorkspaceHintText}'`);
    expect(source).not.toContain("defaultValue: '查看建议起点'");
    expect(source).not.toContain('<Sparkles');
    expect(source).not.toContain('<DsButton');
    expect(source).not.toContain(`messageList.empty.${oldWorkspaceHintKey}`);
    expect(source).not.toContain(`messageList.empty.${oldShowSuggestionsKey}`);
    expect(emptyBlock).not.toContain("const starterPrompt = t('messageList.empty.suggestion2');");
  });

  it('never renders suggestion prompt chips in the empty state (removed by product decision)', () => {
    const source = readSource(messageListPath);
    const emptyStateShellSource = readSource(threadEmptyStateShellPath);

    for (const forbidden of ['thread-empty-suggestions', 'messageList.empty.suggestion', 'DEFAULT_SUGGESTION_KEYS']) {
      expect(source).not.toContain(forbidden);
      expect(emptyStateShellSource).not.toContain(forbidden);
    }
  });

  it('keeps localized primary-action candidate pools paired and group-aware', () => {
    const source = readSource(messageListPath);
    const zhEmpty = readJson(zhChatV2Path).messageList.empty;
    const enEmpty = readJson(enChatV2Path).messageList.empty;

    for (const empty of [zhEmpty, enEmpty]) {
      expect(Array.isArray(empty.primaryActionVariants)).toBe(true);
      expect(Array.isArray(empty.primaryActionInGroupVariants)).toBe(true);
      expect(empty.primaryActionVariants.length).toBe(30);
      expect(empty.primaryActionInGroupVariants.length).toBe(empty.primaryActionVariants.length);
      expect(empty.primaryActionVariants).not.toContain(empty.primaryAction);
      expect(empty.primaryActionInGroupVariants.every((value: string) => value.includes('{{groupName}}'))).toBe(true);
    }

    expect(zhEmpty.primaryActionVariants).not.toEqual(enEmpty.primaryActionVariants);
    expect(source).toContain('const EMPTY_STATE_VARIANT_COUNT = 30;');
    expect(source).toContain('const [emptyStateVariantIndex] = useState(() =>');
    expect(source).toContain("messageList.empty.primaryActionVariants");
    expect(source).toContain("messageList.empty.primaryActionInGroupVariants");
    expect(source).toContain('returnObjects: true');
    expect(source).toContain('defaultValue: []');
    expect(source).toContain('emptyStateVariantIndex,');
    expect(source).toContain(': fallback;');
  });

  it('keeps the existing primary-action keys as the empty-state fallback', () => {
    const source = readSource(messageListPath);
    expect(source).toContain("'messageList.empty.primaryAction'");
    expect(source).toContain("'messageList.empty.primaryActionInGroup'");
    expect(source).toContain('const fallback = emptyStateGroupName');
    expect(source).toContain(': t(\'messageList.empty.primaryAction\');');
    expect(source).toContain("t('messageList.empty.primaryActionInGroup', {");
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
    expect(pageSource).toContain('groupNameMap.get(currentSession.groupId) ?? null');
    expect(pageSource).not.toContain("groupNameMap.get(currentSession.groupId) ?? t('page.studySessions', '课题')");
    expect(pageSource).toContain('emptyStateGroupName={currentSessionGroupName}');
  });
});

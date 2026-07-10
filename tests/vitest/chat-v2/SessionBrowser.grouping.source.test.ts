import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('SessionBrowser grouping source contract', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/session-browser/SessionBrowser.tsx'),
    'utf-8'
  );
  const pageSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/pages/ChatV2Page.tsx'),
    'utf-8'
  );

  it('does not downgrade sessions with missing groups into the ungrouped/global section', () => {
    expect(source).toContain('有 groupId 但分组缺失通常代表归档/删除后的 stale state');
    expect(source).toContain('.filter((s) => !s.groupId)');
    expect(source).not.toContain('.filter((s) => !s.groupId || !groupIdSet.has(s.groupId))');
  });

  it('keeps active sessions with stale group ids visible in an explicit repair bucket', () => {
    expect(pageSource).toContain('const staleSessionGroups = useMemo');
    expect(pageSource).toContain("t('browser.staleTopic'");
    expect(pageSource).toContain('filter((groupId) => !activeGroupIds.has(groupId))');
    expect(pageSource).toContain('[...groups, ...staleSessionGroups]');
    expect(pageSource).toContain('return [...groups, ...staleSessionGroups].map((g) => ({');
    expect(pageSource).toContain('visibleGroups: editableVisibleGroups');
    expect(pageSource).toContain('groups: visibleGroups');
    expect(pageSource).toContain('groupNameMap.get(currentSession.groupId)');
    expect(pageSource).toContain('filteredSessions.filter((s) => !s.groupId)');
  });
});

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const dashboardPath = path.join(repoRoot, 'src/features/settings/components/DataGovernanceDashboard.tsx');
const archiveTabPath = path.join(repoRoot, 'src/features/settings/components/data-governance/ChatSessionArchiveTab.tsx');

describe('chat session archive settings source contract', () => {
  it('adds a dedicated archive tab under data governance', () => {
    const dashboardSource = readFileSync(dashboardPath, 'utf8');

    expect(dashboardSource).toContain("value=\"archive\"");
    expect(dashboardSource).toContain('ChatSessionArchiveTab');
    expect(dashboardSource).toContain('<TabsContent value="archive">');
  });

  it('connects the archive tab to Chat V2 archived-session commands', () => {
    expect(existsSync(archiveTabPath)).toBe(true);

    const archiveTabSource = readFileSync(archiveTabPath, 'utf8');
    expect(archiveTabSource).toContain("'chat_v2_list_sessions'");
    expect(archiveTabSource).toContain("status: 'archived'");
    expect(archiveTabSource).toContain('ARCHIVED_SESSIONS_PAGE_SIZE');
    expect(archiveTabSource).toContain('while (true)');
    expect(archiveTabSource).not.toContain('limit: 100');
    expect(archiveTabSource).toContain("'chat_v2_restore_session'");
    expect(archiveTabSource).toContain("'chat_v2_restore_group'");
    expect(archiveTabSource).toContain("'chat_v2_delete_session'");
    expect(archiveTabSource).toContain("'chat_v2_delete_group'");
    expect(archiveTabSource).not.toContain("'chat_v2_empty_deleted_sessions'");
  });

  it('broadcasts the right Chat V2 refresh events after archive restoration', () => {
    const archiveTabSource = readFileSync(archiveTabPath, 'utf8');

    expect(archiveTabSource).toContain("window.dispatchEvent(new CustomEvent('chat-v2:sessions-updated'))");
    expect(archiveTabSource).toContain("window.dispatchEvent(new CustomEvent('chat-v2:groups-updated'))");
    expect(archiveTabSource).toContain('void restoreGroup(ownerGroup.id);');
    expect(archiveTabSource).toContain('onClick={() => restoreGroup(group.id)}');
    expect(archiveTabSource).toContain('await loadArchivedSessions();');
    expect(archiveTabSource).not.toContain('setSessions((current) => current.filter((session) => session.groupId !== groupId))');
  });

  it('loads archived sessions in pages and refreshes from backend after group deletion', () => {
    const archiveTabSource = readFileSync(archiveTabPath, 'utf8');

    expect(archiveTabSource).toContain('ARCHIVED_SESSIONS_PAGE_SIZE');
    expect(archiveTabSource).toContain('offset += page.length');
    expect(archiveTabSource).toContain('loadAllArchivedSessions()');
    expect(archiveTabSource).toContain('confirmingPermanentDeleteGroupId');
    expect(archiveTabSource).toContain('permanentlyDeleteGroup(group.id)');
    expect(archiveTabSource).toContain('await loadArchivedSessions();');
    expect(archiveTabSource).not.toContain("session.groupId === groupId ? { ...session, groupId: undefined } : session");
    expect(archiveTabSource).toContain('archive_delete_group_confirm');
  });

  it('exposes the archive tab from the data governance overview', () => {
    const dashboardSource = readFileSync(dashboardPath, 'utf8');
    const overviewSource = readFileSync(
      path.join(repoRoot, 'src/features/settings/components/data-governance/OverviewTab.tsx'),
      'utf8'
    );

    expect(dashboardSource).toContain('onOpenArchive={() => setActiveTab(\'archive\')}');
    expect(overviewSource).toContain('onOpenArchive?: () => void');
    expect(overviewSource).toContain('archive_overview_title');
    expect(overviewSource).toContain('archive_overview_action');
  });
});

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
    expect(archiveTabSource).toContain("'chat_v2_restore_session'");
    expect(archiveTabSource).toContain("'chat_v2_delete_session'");
    expect(archiveTabSource).not.toContain("'chat_v2_empty_deleted_sessions'");
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

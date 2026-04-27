import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const dashboardPath = path.join(repoRoot, 'src/components/settings/DataGovernanceDashboard.tsx');
const trashTabPath = path.join(repoRoot, 'src/components/settings/data-governance/ChatSessionTrashTab.tsx');

describe('chat session trash settings source contract', () => {
  it('adds a dedicated trash tab under data governance', () => {
    const dashboardSource = readFileSync(dashboardPath, 'utf8');

    expect(dashboardSource).toContain("value=\"trash\"");
    expect(dashboardSource).toContain('ChatSessionTrashTab');
    expect(dashboardSource).toContain('<TabsContent value="trash">');
  });

  it('connects the trash tab to Chat V2 deleted-session commands', () => {
    expect(existsSync(trashTabPath)).toBe(true);

    const trashTabSource = readFileSync(trashTabPath, 'utf8');
    expect(trashTabSource).toContain("'chat_v2_list_sessions'");
    expect(trashTabSource).toContain("status: 'deleted'");
    expect(trashTabSource).toContain("'chat_v2_restore_session'");
    expect(trashTabSource).toContain("'chat_v2_delete_session'");
    expect(trashTabSource).toContain("'chat_v2_empty_deleted_sessions'");
  });

  it('exposes the trash tab from the data governance overview', () => {
    const dashboardSource = readFileSync(dashboardPath, 'utf8');
    const overviewSource = readFileSync(
      path.join(repoRoot, 'src/components/settings/data-governance/OverviewTab.tsx'),
      'utf8'
    );

    expect(dashboardSource).toContain('onOpenTrash={() => setActiveTab(\'trash\')}');
    expect(overviewSource).toContain('onOpenTrash?: () => void');
    expect(overviewSource).toContain('trash_overview_title');
    expect(overviewSource).toContain('trash_overview_action');
  });
});

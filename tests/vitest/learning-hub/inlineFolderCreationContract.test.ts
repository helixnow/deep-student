import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('learning hub inline folder creation', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/features/learning-hub/LearningHubSidebar.tsx'),
    'utf-8'
  );

  it('renders an unpersisted folder draft and only creates after a non-empty inline edit', () => {
    expect(source).toContain("const PENDING_FOLDER_ID_PREFIX = '__pending_new_folder__'");
    expect(source).toContain('pendingFolderDraft ? [pendingFolderDraft.node, ...items] : items');
    expect(source).toContain("startInlineEdit(pendingId, 'folder', '')");
    expect(source).toContain('if (isPendingFolderId(itemId))');
    expect(source).toContain('draft.parentFolderId ?? undefined');
  });

  it('cancels an empty or escaped draft without using a create dialog', () => {
    expect(source).toContain('pendingFolderDraftRef.current?.node.id !== itemId');
    expect(source).toContain('if (isPendingFolderId(itemId))');
    expect(source).not.toContain('<DsDialog open={createDialogOpen}');
  });
});

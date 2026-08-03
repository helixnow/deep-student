import { describe, expect, it } from 'vitest';
import { ArrowsLeftRight, Cards, FileText, Files, FolderOpen, FolderPlus, MagnifyingGlass, Trash, Wrench } from '@phosphor-icons/react';
import { getToolVisual } from '../toolVisual';

describe('getToolVisual', () => {
  it('distinguishes resource and folder listings from generic tools', () => {
    expect(getToolVisual('builtin-resource_list')).toMatchObject({
      Icon: Files,
      kind: 'resource',
    });
    expect(getToolVisual('builtin-folder_list')).toMatchObject({
      Icon: FolderOpen,
      kind: 'folder',
    });
  });

  it('uses semantic variants for resource search and folder actions', () => {
    expect(getToolVisual('builtin-resource_search')).toMatchObject({
      Icon: MagnifyingGlass,
      kind: 'search',
    });
    expect(getToolVisual('builtin-dstu_folder_create')).toMatchObject({
      Icon: FolderPlus,
      kind: 'folder',
    });
  });

  it('maps common action verbs and learning workflows to recognisable icons', () => {
    expect(getToolVisual('builtin-resource_read')).toMatchObject({ Icon: FileText, kind: 'read' });
    expect(getToolVisual('builtin-dstu_move')).toMatchObject({ Icon: ArrowsLeftRight, kind: 'move' });
    expect(getToolVisual('builtin-dstu_delete')).toMatchObject({ Icon: Trash, kind: 'delete' });
    expect(getToolVisual('builtin-chatanki_run')).toMatchObject({ Icon: Cards, kind: 'learning' });
  });

  it('keeps unknown tools on the neutral fallback', () => {
    expect(getToolVisual('partner_custom_action')).toMatchObject({
      Icon: Wrench,
      kind: 'default',
    });
  });

  it('uses one neutral visual treatment for every tool category', () => {
    expect(getToolVisual('builtin-resource_list')).toMatchObject({
      className: 'text-muted-foreground',
      backgroundClassName: 'bg-muted/70 dark:bg-muted/40',
    });
    expect(getToolVisual('builtin-dstu_delete')).toMatchObject({
      className: 'text-muted-foreground',
      backgroundClassName: 'bg-muted/70 dark:bg-muted/40',
    });
  });
});

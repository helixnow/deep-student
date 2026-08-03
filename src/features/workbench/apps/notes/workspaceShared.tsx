import React from 'react';
import { FileText, TreeStructure } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import type { NotesWorkspaceResourceRef } from './workspaceRegistry';

export type ResourceType = NotesWorkspaceResourceRef['type'];

export interface WorkspaceTab extends NotesWorkspaceResourceRef {
  key: string;
  title: string;
  pinned?: boolean;
}

export type SaveState = 'saved' | 'saving' | 'dirty';
export type WorkspacePaneId = 'main' | 'right';
export type TabDropPosition = 'before' | 'after';

export const IconButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }> = ({
  label,
  children,
  className,
  ...props
}) => (
  <button {...props} type="button" className={cn('notes-icon-button', className)} aria-label={label} title={label}>
    {children}
  </button>
);

export const ResourceGlyph: React.FC<{ type: ResourceType; size?: number }> = ({ type, size = 15 }) =>
  type === 'note'
    ? <FileText size={size} aria-hidden />
    : <TreeStructure size={size} aria-hidden />;

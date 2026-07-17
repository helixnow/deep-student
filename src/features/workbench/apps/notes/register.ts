import React from 'react';
import { NotePencil } from '@phosphor-icons/react';
import i18next from 'i18next';
import { appRegistry } from '../../core/appRegistry';
import type { AppDefinition } from '../../core/types';
import { handleNotesActivation } from './notesActivation';
import { createNotesAgentManifest } from './agentManifest';
import { requestContentCloseConfirmation } from '../content/ContentCloseConfirmation';
import { hasUnsavedNotesWorkspaceChanges } from './workspaceRegistry';

export const NOTES_APP_TYPE_ID = 'notes';

async function canCloseNotesWorkspace(_instanceKey: string | null): Promise<boolean> {
  if (!hasUnsavedNotesWorkspaceChanges()) return true;
  try {
    return await requestContentCloseConfirmation({
      description: i18next.t('workbench:content.confirmCloseUnsaved'),
    });
  } catch {
    // If the confirmation host cannot respond, retain the window and edits.
    return false;
  }
}

export const notesAppDefinition: AppDefinition = {
  typeId: NOTES_APP_TYPE_ID,
  nameKey: 'workbench:apps.note',
  icon: React.createElement(NotePencil, { size: 22, weight: 'duotone' }),
  instanceMode: 'single',
  memoryWeight: 3,
  defaultFrame: { w: 1180, h: 760 },
  minSize: { w: 480, h: 420 },
  render: React.lazy(() => import('./NotesWorkspaceApp')),
  onActivation: handleNotesActivation,
  agentManifest: createNotesAgentManifest(handleNotesActivation),
  canClose: canCloseNotesWorkspace,
  handlesCloseShortcut: true,
};

let registered = false;

export function registerNotesApp(): void {
  if (registered) return;
  registered = true;
  appRegistry.register(notesAppDefinition);
}

registerNotesApp();

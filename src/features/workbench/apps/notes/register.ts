import React from 'react';
import { NotePencil } from '@phosphor-icons/react';
import { appRegistry } from '../../core/appRegistry';
import type { AppDefinition } from '../../core/types';
import { handleNotesActivation } from './notesActivation';
import { createNotesAgentManifest } from './agentManifest';

export const NOTES_APP_TYPE_ID = 'notes';

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
};

let registered = false;

export function registerNotesApp(): void {
  if (registered) return;
  registered = true;
  appRegistry.register(notesAppDefinition);
}

registerNotesApp();

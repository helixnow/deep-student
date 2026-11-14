/** note_history.rs: read-only dependency enumeration. L10 owns all note writes. */
import { defineQuery } from '../../../platform/storage/query.ts';

export const selectFormatIds = defineQuery<[string], { note_id: string }>(
  'SELECT note_id FROM note_document_formats WHERE note_id=?1 ORDER BY note_id',
  { name: 'syncSupport.noteHistory.formatIds' },
);
export const selectRevisionIds = defineQuery<[string], { version_id: string }>(
  'SELECT version_id FROM note_document_revisions WHERE note_id=?1 ORDER BY seq',
  { name: 'syncSupport.noteHistory.revisionIds' },
);
export const selectRelationIds = defineQuery<[string], { id: string }>(
  'SELECT id FROM note_learning_relations WHERE note_id=?1 ORDER BY note_id',
  { name: 'syncSupport.noteHistory.relationIds' },
);
export const selectAffectedNotesByNote = defineQuery<[string], { id: string }>(
  'SELECT id FROM notes WHERE id=?1',
  { name: 'syncSupport.noteHistory.affectedByNote' },
);
export const selectAffectedNotesByResource = defineQuery<[string], { id: string }>(
  'SELECT id FROM notes WHERE resource_id=?1',
  { name: 'syncSupport.noteHistory.affectedByResource' },
);

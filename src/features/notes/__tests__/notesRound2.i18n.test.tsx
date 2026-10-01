import React from 'react';
import path from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import zh from '@/locales/zh-CN/notes.json';
import en from '@/locales/en-US/notes.json';

const { language, repository, invoke } = await vi.hoisted(async () => ({
  language: (await import('i18next')).createInstance(),
  repository: { list: vi.fn(), watch: vi.fn(() => () => {}) },
  invoke: vi.fn(),
}));
// The suite's default alias only serves Chinese and can conceal missing English keys.
vi.mock('react-i18next', () => vi.importActual<typeof import('react-i18next')>(
  path.resolve(process.cwd(), 'node_modules/react-i18next/dist/es/index.js'),
));
vi.mock('@/i18n', () => ({ default: language }));
vi.mock('@/dstu', () => ({ dstu: repository }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('../personalNoteTemplates', () => ({
  loadPersonalNoteTemplates: async () => [],
  getCourseDefaultTemplate: () => undefined,
}));
vi.mock('../components/NoteRelationPreview', () => ({ NoteRelationPreview: () => null }));
import { NotesLibraryEntry } from '../NotesLibraryView';
import { CreateLearningNoteDialog } from '../components/CreateLearningNoteDialog';
import { LegacyLearningPropsMapper } from '../components/LegacyLearningPropsMapper';
import { NoteLearningRelations } from '../components/NoteLearningRelations';
import { deleteNoteDraft, loadNoteDrafts, newDurableDraft, persistNoteDraft } from '../noteDraftPersistence';

beforeAll(async () => {
  await language.init({ lng: 'en-US', fallbackLng: false, defaultNS: 'notes',
    resources: { 'en-US': { notes: en }, 'zh-CN': { notes: zh } }, interpolation: { escapeValue: false } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const view = (children: React.ReactNode) => render(<I18nextProvider i18n={language}>{children}</I18nextProvider>);

describe('notes round two with real English translations', () => {
  it('opens the notes library and creation form with translated labels', async () => {
    repository.list.mockResolvedValue({ ok: true, value: [] });
    view(<NotesLibraryEntry onOpen={vi.fn()}>Resources</NotesLibraryEntry>);
    fireEvent.click(screen.getByRole('button', { name: 'Learning notes' }));
    expect(await screen.findByText('No notes yet')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Search notes, courses, or chapters' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New learning note' }));
    expect(screen.getByRole('dialog', { name: 'New learning note' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Note title' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Course default: Not set' })).toBeDisabled();
    await waitFor(() => expect(screen.queryByText('Loading personal templates…')).toBeNull());
  });

  it('uses English built-in templates and previews legacy mapping without translating user data', async () => {
    const creation = view(<CreateLearningNoteDialog onCreated={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('option', { name: 'Lecture notes' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Template for new note' }), { target: { value: 'lecture' } });
    expect(screen.getByLabelText('Template content preview')).toHaveTextContent('Core concepts');
    await waitFor(() => expect(screen.queryByText('Loading personal templates…')).toBeNull());
    creation.unmount();
    view(<LegacyLearningPropsMapper value={{ oldCourse: '数学' }} onSave={vi.fn()} />);
    fireEvent.click(screen.getByText('Map existing custom properties'));
    fireEvent.change(screen.getByLabelText('Source property for Course'), { target: { value: 'oldCourse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview mapping' }));
    expect(await screen.findByRole('button', { name: 'Apply mapping' })).toBeInTheDocument();
    expect(screen.getByLabelText('Preview mapping')).toHaveTextContent('数学');
  });

  it('translates relation types, resource picker and validation errors', async () => {
    const service = { list: vi.fn(async () => []), put: vi.fn(), delete: vi.fn(), referenceStatus: vi.fn() };
    repository.list.mockResolvedValue({ ok: true, value: [] });
    view(<NoteLearningRelations noteId="english-note" service={service} />);
    await screen.findByText('No learning resources linked yet');
    expect(screen.getByRole('option', { name: 'Source PDF' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Choose from library' }));
    await screen.findByText('No matching resources');
    expect(screen.getByRole('textbox', { name: 'Find resources to link' })).toBeInTheDocument();
    fireEvent.click(screen.getByText('Link by resource ID'));
    fireEvent.change(screen.getByLabelText('Resource ID (document ID for cards)'), { target: { value: 'file_1' } });
    fireEvent.change(screen.getByLabelText('PDF page number'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a valid page number starting from 1.');
    expect(service.put).not.toHaveBeenCalled();
  });

  it('translates storage confirmations and recovery fallback without replacing stored error details', async () => {
    const draft = newDurableDraft('body', 'original error', undefined, 'window');
    invoke.mockResolvedValue(null);
    await expect(persistNoteDraft('english-note', draft)).rejects.toThrow('Draft storage was not confirmed.');
    await expect(deleteNoteDraft('english-note', draft)).rejects.toThrow('The draft has not been stored yet.');
    draft.persistenceRevision = 1;
    await expect(deleteNoteDraft('english-note', draft)).rejects.toThrow('Draft deletion was not confirmed.');
    invoke.mockResolvedValue([{ note_id: 'english-note', type: 'draft', key: 'recovered', revision: 1, deleted: false, value: { markdown: 'body' } },
      { note_id: 'english-note', type: 'draft', key: 'with-error', revision: 1, deleted: false, value: { markdown: 'body', error: 'original error' } }]);
    const restored = await loadNoteDrafts('english-note');
    expect(restored.map(item => item.error)).toEqual(['Unsaved draft recovered.', 'original error']);
  });
});

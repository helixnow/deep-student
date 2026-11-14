/** DSTU soft-delete entry points; L10/L11 own all writes on the caller's connection. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { callNoteRepository, notesRepository, vfsRepositories } from './services.ts';

/** note_repo.rs:1477-1516 */
export function deleteNoteWithConn(conn: SqlExecutor, noteId: string): void {
  callNoteRepository(() => notesRepository().deleteNote(noteId, conn));
}

/** note_repo.rs:2367-2425 */
export function deleteNoteWithFolderItemWithConn(conn: SqlExecutor, noteId: string): void {
  callNoteRepository(() => notesRepository().deleteNoteWithFolderItem(noteId, conn));
}

/** textbook_repo.rs:865-900 */
export function deleteTextbookWithConn(conn: SqlExecutor, textbookId: string): void {
  vfsRepositories().textbooks.deleteTextbook(conn, textbookId);
}

/** textbook_repo.rs:1463-1488 */
export function deleteTextbookWithFolderItemWithConn(conn: SqlExecutor, textbookId: string): void {
  vfsRepositories().textbooks.deleteTextbookWithFolderItem(conn, textbookId);
}

/** translation_repo.rs:615-666 (includes folder_items cascade). */
export function deleteTranslationWithConn(conn: SqlExecutor, translationId: string): void {
  vfsRepositories().translations.deleteTranslation(conn, translationId);
}

/** exam_repo.rs:865-928 */
export function deleteExamSheetWithConn(conn: SqlExecutor, examId: string): void {
  vfsRepositories().exams.deleteExamSheet(conn, examId);
}

/** exam_repo.rs:1695-1747 */
export function deleteExamSheetWithFolderItemWithConn(conn: SqlExecutor, examId: string): void {
  vfsRepositories().exams.deleteExamSheetWithFolderItem(conn, examId);
}

/** essay_repo.rs:1099-1134 */
export function deleteEssaySessionWithConn(conn: SqlExecutor, sessionId: string): void {
  vfsRepositories().essays.deleteSession(conn, sessionId);
}

/** essay_repo.rs:1145-1160 */
export function deleteEssaySessionWithFolderItemWithConn(conn: SqlExecutor, sessionId: string): void {
  vfsRepositories().essays.deleteSessionWithFolderItem(conn, sessionId);
}

/** essay_repo.rs:490-525 */
export function deleteEssayWithConn(conn: SqlExecutor, essayId: string): void {
  vfsRepositories().essays.deleteEssay(conn, essayId);
}

/** essay_repo.rs:1476-1499 */
export function deleteEssayWithFolderItemWithConn(conn: SqlExecutor, essayId: string): void {
  vfsRepositories().essays.deleteEssayWithFolderItem(conn, essayId);
}

/** file_repo.rs:967-1016 */
export function deleteFileWithConn(conn: SqlExecutor, fileId: string): void {
  vfsRepositories().files.deleteFile(conn, fileId);
}

/** mindmap_repo.rs:1066-1130 */
export function deleteMindmapWithConn(conn: SqlExecutor, mindmapId: string): void {
  vfsRepositories().mindmaps.deleteMindmapWithConn(conn, mindmapId);
}

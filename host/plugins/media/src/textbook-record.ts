import type { VfsTextbook } from '../../vfs-repos/api.ts';
import type { Textbook } from '../../../../contracts/ipc/generated/L18-media-docs.ts';

/** VfsTextbook::to_textbook (textbooks_db.rs). */
export function toTextbook(textbook: VfsTextbook): Textbook {
  return {
    id: textbook.id,
    sha256: textbook.sha256,
    file_name: textbook.fileName,
    file_path: textbook.originalPath ?? '',
    size: textbook.size,
    page_count: textbook.pageCount ?? null,
    tags_json: JSON.stringify(textbook.tags),
    favorite: textbook.isFavorite ? 1 : 0,
    last_opened_at: textbook.lastOpenedAt ?? null,
    last_page: textbook.lastPage ?? null,
    bookmarks_json: JSON.stringify(textbook.bookmarks),
    cover_key: textbook.coverKey ?? null,
    origin_json: null,
    status: textbook.status,
    created_at: textbook.createdAt,
    updated_at: textbook.updatedAt,
  };
}

export function extensionOf(fileName: string): string | null {
  const index = fileName.lastIndexOf('.');
  if (index <= 0 || index === fileName.length - 1) return null;
  return fileName.slice(index + 1).toLowerCase();
}

-- Metadata for the VFS writer capability gate.
--
-- The gate itself is enforced by triggers that are installed only when the
-- first ink board is published (see dstu_storage::sqlite_capability). This
-- migration reserves the marker row so an upgraded writer can report the
-- expected capability before any board exists. `guard_installed = 1` means
-- the write-blocking triggers have been installed.
--
-- Older readers that only know schema V20261103 do not run this migration and
-- may still open the database. That is intentional: a v1 database without a
-- board remains fully writable by older readers. Once a board is published,
-- the triggers fail closed for connections that did not register the writer
-- capability, while SELECTs remain available.
CREATE TABLE IF NOT EXISTS __vfs_writer_guard (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    min_writer_capability INTEGER NOT NULL CHECK (min_writer_capability > 0),
    guard_installed INTEGER NOT NULL DEFAULT 0 CHECK (guard_installed IN (0, 1)),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO __vfs_writer_guard (id, min_writer_capability, guard_installed)
VALUES (1, 5, 0)
ON CONFLICT(id) DO UPDATE
SET min_writer_capability = excluded.min_writer_capability;

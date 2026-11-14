import { describe, expect, it } from 'vitest';
import type { SyncStateStore } from '../api.ts';
import { serviceHost } from './service-host.ts';

const operations: { label: string; table: string; event: string; call: (state: SyncStateStore) => unknown }[] = [
  { label: 'tombstone 事件序号', table: 'tombstone_event_publish', event: 'INSERT',
    call: s => s.reserveTombstoneEventSeq('i', 'd', 'blobs', 'op', 0n) },
  { label: '设备轮换', table: 'device_history', event: 'INSERT', call: s => s.recordDeviceRotation('a', 'b', 'restore') },
  { label: '清空同步基线', table: 'consume_cursor', event: 'DELETE', call: s => s.resetDefaultAfterLocalPurge() },
];

describe('R4 S05: state transaction failure phases through the public service', () => {
  for (const op of operations) {
    it(`${op.label}: BEGIN failure retains the caller transaction`, async () => {
      const h = await serviceHost();
      try {
        h.db.exec('BEGIN');
        expect(() => op.call(h.service.state)).toThrow(
          `Database error: 开始${op.label.startsWith('tombstone') ? ' ' : ''}${op.label}事务失败: cannot start a transaction within a transaction`,
        );
        h.db.exec('ROLLBACK');
      } finally { await h.dispose(); }
    });

    it(`${op.label}: deferred constraint failure is COMMIT, and all writes roll back`, async () => {
      const h = await serviceHost();
      try {
        h.service.state.setCursor('i', 'd', 7n);
        h.db.exec(`PRAGMA foreign_keys=ON;
          CREATE TABLE parent(id INTEGER PRIMARY KEY);
          CREATE TABLE child(parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);
          CREATE TRIGGER fail_at_commit AFTER ${op.event} ON ${op.table}
          BEGIN INSERT INTO child VALUES (999); END;`);
        expect(() => op.call(h.service.state)).toThrow(
          `Database error: 提交${op.label.startsWith('tombstone') ? ' ' : ''}${op.label}事务失败: FOREIGN KEY constraint failed`,
        );
        expect(h.db.pluck('SELECT COUNT(*) FROM child')).toBe(0);
        expect(h.service.state.getCursor('i', 'd')).toBe(7n);
        expect(h.db.pluck('SELECT COUNT(*) FROM device_history')).toBe(0);
        expect(h.db.pluck('SELECT COUNT(*) FROM tombstone_event_publish')).toBe(0);
        // Failed COMMIT releases the transaction; the next operation succeeds.
        h.db.exec('DROP TRIGGER fail_at_commit');
        expect(() => op.call(h.service.state)).not.toThrow();
      } finally { await h.dispose(); }
    });
  }

  it('statement failure keeps its read context and rolls back', async () => {
    const h = await serviceHost();
    try {
      h.db.exec('DROP TABLE tombstone_event_publish');
      expect(() => h.service.state.reserveTombstoneEventSeq('i', 'd', 'blobs', 'op', 0n)).toThrow(
        'Database error: 读取 tombstone 事件序号失败: no such table: tombstone_event_publish',
      );
      // No leaked transaction after the failed SELECT.
      expect(() => h.service.state.recordDeviceRotation('a', 'b', 'restore')).not.toThrow();
    } finally { await h.dispose(); }
  });

  it('cursors reports device and sequence column conversion failures separately', async () => {
    const h = await serviceHost();
    try {
      h.db.exec(`INSERT INTO consume_cursor VALUES ('i', 'd', 'bad-sequence', 'now')`);
      expect(() => h.service.state.cursors('i')).toThrow(
        'Database error: 读取游标序号失败: Invalid column type Text at index: 1, name: last_seq',
      );
      h.db.exec("DELETE FROM consume_cursor; INSERT INTO consume_cursor VALUES ('i', X'00', 1, 'now')");
      expect(() => h.service.state.cursors('i')).toThrow(
        'Database error: 读取游标设备失败: Invalid column type Blob at index: 0, name: uploader_device_id',
      );
    } finally { await h.dispose(); }
  });

  it('device rotations reports row parsing failure rather than returning invalid tuples', async () => {
    const h = await serviceHost();
    try {
      h.db.exec("INSERT INTO device_history VALUES ('a', 'b', 'now', X'00')");
      expect(() => h.service.state.deviceRotationsForNew('b')).toThrow(
        'Database error: 解析设备轮换历史失败: Invalid column type Blob at index: 1, name: reason',
      );
    } finally { await h.dispose(); }
  });

  it('cursors missing-table failure retains the prepare-stage read prefix', async () => {
    const h = await serviceHost();
    try {
      h.db.exec('DROP TABLE consume_cursor');
      expect(() => h.service.state.cursors('i')).toThrow(
        'Database error: 读取消费游标失败: no such table: consume_cursor',
      );
    } finally { await h.dispose(); }
  });

  it('device rotations missing-table failure retains the prepare-stage read prefix', async () => {
    const h = await serviceHost();
    try {
      h.db.exec('DROP TABLE device_history');
      expect(() => h.service.state.deviceRotationsForNew('d')).toThrow(
        'Database error: 读取设备轮换历史失败: no such table: device_history',
      );
    } finally { await h.dispose(); }
  });

  it('cursors maps first-step and later-step failures to the rows.next context', async () => {
    const h = await serviceHost();
    try {
      h.db.exec(`DROP TABLE consume_cursor;
        CREATE VIEW consume_cursor AS
        SELECT 'i' AS instance_id, 'd' AS uploader_device_id, abs(-9223372036854775808) AS last_seq;`);
      expect(() => h.service.state.cursors('i')).toThrow('Database error: 遍历消费游标失败: integer overflow');
      h.db.exec(`DROP VIEW consume_cursor;
        CREATE VIEW consume_cursor AS
        SELECT 'i' AS instance_id, 'd' AS uploader_device_id, 1 AS last_seq
        UNION ALL SELECT 'i', 'e', abs(-9223372036854775808);`);
      expect(() => h.service.state.cursors('i')).toThrow('Database error: 遍历消费游标失败: integer overflow');
      h.db.exec('DROP VIEW consume_cursor');
    } finally { await h.dispose(); }
  });

  it('device rotations maps a first-step failure to the mapped-row context', async () => {
    const h = await serviceHost();
    try {
      h.db.exec(`DROP TABLE device_history;
        CREATE VIEW device_history AS
        SELECT 'o' AS old_device_id, 'd' AS new_device_id, abs(-9223372036854775808) AS reason;`);
      expect(() => h.service.state.deviceRotationsForNew('d')).toThrow(
        'Database error: 解析设备轮换历史失败: integer overflow',
      );
      h.db.exec('DROP VIEW device_history');
    } finally { await h.dispose(); }
  });
});

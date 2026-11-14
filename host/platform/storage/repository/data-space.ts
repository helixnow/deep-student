import Database from 'better-sqlite3';
import { storageLog } from '../logging.ts';

const LOG_TARGET = 'dstu_storage::data_space';

/** data_space.rs:678 `is_valid_sqlite_database`. */
export function isValidSqliteDatabase(file: string): boolean {
  let connection: Database.Database;
  try { connection = new Database(file, { readonly: true, fileMustExist: true }); }
  catch (error) {
    storageLog(LOG_TARGET, 'warn', `[DataSpace] 核心数据库无法只读打开 ${file}: ${String(error)}`);
    return false;
  }
  try {
    const result = String(connection.prepare('PRAGMA quick_check(1)').pluck().get());
    if (result.toLowerCase() === 'ok') return true;
    storageLog(LOG_TARGET, 'warn', `[DataSpace] 核心数据库完整性检查失败 ${file}: ${result}`);
    return false;
  } catch (error) {
    storageLog(LOG_TARGET, 'warn', `[DataSpace] 核心数据库完整性检查无法完成 ${file}: ${String(error)}`);
    return false;
  } finally {
    connection.close();
  }
}

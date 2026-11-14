import { StorageError } from '../../../platform/storage/api.ts';
import { ChatV2Error } from '../src/error.ts';

export function databaseOperation<T>(action: () => T): T {
  try { return action(); } catch (error) {
    if (error instanceof StorageError) throw new ChatV2Error('Database', error.message);
    throw error;
  }
}

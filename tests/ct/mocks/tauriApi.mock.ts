type AnyAsyncFn = (...args: any[]) => Promise<any>;

const asyncNoop: AnyAsyncFn = async () => undefined;

// Keep a small set of commonly-used stable return shapes
export type BackupTier = 'core_config_chat' | 'vfs_full' | 'rebuildable' | 'large_files';

export interface DatabaseInfo {
  production_db_path: string;
  test_db_path: string;
  test_db_exists: boolean;
  production_db_exists: boolean;
  active_database: 'production' | 'test';
}

export interface TestDatabaseSwitchResponse {
  success: boolean;
  test_db_path?: string;
  production_db_path?: string;
  message: string;
  deleted_files?: string[];
  active_database?: 'production' | 'test';
}

export const TestDatabaseAPI = {
  switchToTest: async (): Promise<TestDatabaseSwitchResponse> => ({
    success: true,
    message: 'mock: switched to test',
    active_database: 'test',
    test_db_path: 'mock://test.db',
    production_db_path: 'mock://prod.db',
  }),
  reset: async (): Promise<TestDatabaseSwitchResponse> => ({
    success: true,
    message: 'mock: reset test database',
    active_database: 'test',
    test_db_path: 'mock://test.db',
    production_db_path: 'mock://prod.db',
  }),
  switchToProduction: async (): Promise<TestDatabaseSwitchResponse> => ({
    success: true,
    message: 'mock: switched to production',
    active_database: 'production',
    test_db_path: 'mock://test.db',
    production_db_path: 'mock://prod.db',
  }),
  getInfo: async (): Promise<DatabaseInfo> => ({
    production_db_path: 'mock://prod.db',
    test_db_path: 'mock://test.db',
    test_db_exists: true,
    production_db_exists: true,
    active_database: 'production',
  }),
  seed: async (): Promise<{
    success: boolean;
    mistakes_created: number;
    messages_created: number;
    errors: string[];
  }> => ({
    success: true,
    mistakes_created: 0,
    messages_created: 0,
    errors: [],
  }),
};

export async function ocrExtractText(_options: { imagePath?: string; imageBase64?: string }): Promise<string> {
  return '';
}

// Types that are imported as `type` in multiple modules.
export type MistakeItem = any;
export type ExamSheetProgressEvent = any;
export type ExamSheetSessionDetail = any;

export interface TranslationHistoryItem {
  id: string;
  source_text: string;
  translated_text: string;
  src_lang: string;
  tgt_lang: string;
  prompt_used?: string | null;
  created_at: string;
  is_favorite: boolean;
  quality_rating?: number | null;
}

// The real app exports a huge static class; for tests we provide a resilient stub
// where unknown methods become async no-ops.
const tauriApiBase: Record<string, any> = {
  invoke: async (_cmd: string, _args?: any) => null,
};

export const TauriAPI = new Proxy(tauriApiBase, {
  get(target, prop) {
    if (prop in target) return (target as any)[prop];
    return asyncNoop;
  },
}) as any;

export default { TauriAPI, TestDatabaseAPI, ocrExtractText };

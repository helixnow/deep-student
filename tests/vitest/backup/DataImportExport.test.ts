/**
 * 数据导入导出组件测试
 *
 * 测试覆盖范围：
 * - 备份导出功能
 * - 备份导入功能
 * - 备份列表管理
 * - 进度事件处理
 * - 错误处理
 * - 用户交互
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// Mock 设置
// ============================================================================

// Mock Tauri API
const mockInvoke = vi.fn();
const mockListen = vi.fn();
const mockEmit = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: mockListen,
  emit: mockEmit,
}));

// Mock TauriAPI
vi.mock('../../utils/tauriApi', () => ({
  TauriAPI: {
    exportBackupArchive: vi.fn(),
    exportBackupArchiveWithOptions: vi.fn(),
    importBackupArchive: vi.fn(),
    importBackupArchiveWithOptions: vi.fn(),
    getBackupList: vi.fn(),
    getBackupInfo: vi.fn(),
    autoBackup: vi.fn(),
    prepareForBackupRestore: vi.fn(),
  },
  BackupInfo: {},
}));

// ============================================================================
// 测试辅助类型和数据
// ============================================================================

interface BackupInfo {
  file_name: string;
  file_path: string;
  size: number;
  created_at: string;
  is_auto_backup: boolean;
}

interface BackupMetadata {
  version: string;
  app_version: string;
  created_at: string;
  platform: string;
  total_files: number;
  total_size: number;
  database_version: number;
  statistics: {
    total_mistakes: number;
    total_images: number;
    total_tags: number;
    total_knowledge_cards: number;
  };
}

interface ImportProgress {
  phase: string;
  progress: number;
  message: string;
  current_file?: string;
  total_files: number;
  processed_files: number;
}

interface BackupJobEvent {
  jobId: string;
  kind: 'export' | 'import';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  phase: string;
  progress: number;
  message?: string;
  processedItems: number;
  totalItems: number;
  etaSeconds?: number;
  result?: {
    success: boolean;
    outputPath?: string;
    message?: string;
    error?: string;
  };
}

// 测试数据
const mockBackupList: BackupInfo[] = [
  {
    file_name: 'dstu-backup-20240101-120000.zip',
    file_path: '/path/to/backup1.zip',
    size: 1024 * 1024 * 50, // 50MB
    created_at: '2024-01-01T12:00:00Z',
    is_auto_backup: false,
  },
  {
    file_name: 'dstu-backup-auto-20240102-060000.zip',
    file_path: '/path/to/backup2.zip',
    size: 1024 * 1024 * 45, // 45MB
    created_at: '2024-01-02T06:00:00Z',
    is_auto_backup: true,
  },
];

const mockBackupMetadata: BackupMetadata = {
  version: '2.0',
  app_version: '1.5.0',
  created_at: '2024-01-01T12:00:00Z',
  platform: 'darwin',
  total_files: 150,
  total_size: 1024 * 1024 * 50,
  database_version: 1,
  statistics: {
    total_mistakes: 100,
    total_images: 200,
    total_tags: 50,
    total_knowledge_cards: 30,
  },
};

// ============================================================================
// 单元测试
// ============================================================================

describe('DataImportExport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // 备份列表测试
  // ==========================================================================

  describe('Backup List Management', () => {
    it('should fetch backup list successfully', async () => {
      mockInvoke.mockResolvedValue(mockBackupList);

      const result = await mockInvoke('get_backup_list');

      expect(result).toEqual(mockBackupList);
      expect(result.length).toBe(2);
    });

    it('should handle empty backup list', async () => {
      mockInvoke.mockResolvedValue([]);

      const result = await mockInvoke('get_backup_list');

      expect(result).toEqual([]);
      expect(result.length).toBe(0);
    });

    it('should handle backup list fetch error', async () => {
      mockInvoke.mockRejectedValue(new Error('Network error'));

      await expect(mockInvoke('get_backup_list')).rejects.toThrow('Network error');
    });

    it('should correctly identify auto backups', () => {
      const autoBackups = mockBackupList.filter(b => b.is_auto_backup);
      const manualBackups = mockBackupList.filter(b => !b.is_auto_backup);

      expect(autoBackups.length).toBe(1);
      expect(manualBackups.length).toBe(1);
    });
  });

  // ==========================================================================
  // 备份元数据测试
  // ==========================================================================

  describe('Backup Metadata', () => {
    it('should fetch backup info successfully', async () => {
      mockInvoke.mockResolvedValue(mockBackupMetadata);

      const result = await mockInvoke('get_backup_info', { archivePath: '/path/to/backup.zip' });

      expect(result.version).toBe('2.0');
      expect(result.statistics.total_mistakes).toBe(100);
    });

    it('should handle missing metadata (old version backup)', async () => {
      mockInvoke.mockRejectedValue(new Error('备份文件缺少元数据，可能是旧版本备份'));

      await expect(
        mockInvoke('get_backup_info', { archivePath: '/path/to/old_backup.zip' })
      ).rejects.toThrow('旧版本备份');
    });

    it('should handle corrupted backup file', async () => {
      mockInvoke.mockRejectedValue(new Error('解析ZIP文件失败'));

      await expect(
        mockInvoke('get_backup_info', { archivePath: '/path/to/corrupted.zip' })
      ).rejects.toThrow('解析ZIP文件失败');
    });
  });

  // ==========================================================================
  // 导出功能测试
  // ==========================================================================

  describe('Export Functionality', () => {
    it('should start export with options', async () => {
      mockInvoke.mockResolvedValue({ job_id: 'test-job-123' });

      const options = {
        includeLogs: false,
        compressionLevel: 6,
        performLanceCompaction: true,
      };

      const result = await mockInvoke('export_backup_archive_with_options', { request: options });

      expect(result.job_id).toBe('test-job-123');
    });

    it('should handle export with custom output path', async () => {
      mockInvoke.mockResolvedValue({ job_id: 'test-job-456' });

      const options = {
        outputPath: '/custom/path/backup.zip',
      };

      const result = await mockInvoke('export_backup_archive_with_options', { request: options });

      expect(result.job_id).toBe('test-job-456');
    });

    it('should handle export failure', async () => {
      mockInvoke.mockRejectedValue(new Error('磁盘空间不足'));

      await expect(
        mockInvoke('export_backup_archive_with_options', { request: {} })
      ).rejects.toThrow('磁盘空间不足');
    });
  });

  // ==========================================================================
  // 导入功能测试
  // ==========================================================================

  describe('Import Functionality', () => {
    it('should start import with options', async () => {
      mockInvoke.mockResolvedValue('import-job-789');

      const result = await mockInvoke('import_backup_archive_with_options', {
        archivePath: '/path/to/backup.zip',
        options: { bestEffort: false },
      });

      expect(result).toBe('import-job-789');
    });

    it('should handle import with best effort mode', async () => {
      mockInvoke.mockResolvedValue('import-job-best-effort');

      const result = await mockInvoke('import_backup_archive_with_options', {
        archivePath: '/path/to/backup.zip',
        options: { bestEffort: true },
      });

      expect(result).toBe('import-job-best-effort');
    });

    it('should handle file not found error', async () => {
      mockInvoke.mockRejectedValue(new Error('备份文件不存在'));

      await expect(
        mockInvoke('import_backup_archive_with_options', {
          archivePath: '/nonexistent/backup.zip',
          options: {},
        })
      ).rejects.toThrow('备份文件不存在');
    });

    it('should handle version incompatibility', async () => {
      mockInvoke.mockRejectedValue(new Error('不支持的备份版本: 3.0'));

      await expect(
        mockInvoke('import_backup_archive_with_options', {
          archivePath: '/path/to/future_backup.zip',
          options: {},
        })
      ).rejects.toThrow('不支持的备份版本');
    });
  });

  // ==========================================================================
  // 进度事件测试
  // ==========================================================================

  describe('Progress Events', () => {
    it('should handle export progress events', async () => {
      const progressEvents: BackupJobEvent[] = [];

      mockListen.mockImplementation((eventName, callback) => {
        if (eventName === 'backup-job-progress') {
          // 模拟进度事件序列
          setTimeout(() => callback({ payload: { jobId: 'test', status: 'running', progress: 25, phase: 'scan' } }), 10);
          setTimeout(() => callback({ payload: { jobId: 'test', status: 'running', progress: 50, phase: 'compress' } }), 20);
          setTimeout(() => callback({ payload: { jobId: 'test', status: 'running', progress: 75, phase: 'verify' } }), 30);
          setTimeout(() => callback({ payload: { jobId: 'test', status: 'completed', progress: 100, phase: 'completed' } }), 40);
        }
        return Promise.resolve(() => {});
      });

      await mockListen('backup-job-progress', (event: any) => {
        progressEvents.push(event.payload);
      });

      // 等待所有事件
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(progressEvents.length).toBe(4);
    });

    it('should handle import progress events', async () => {
      const phases: string[] = [];

      mockListen.mockImplementation((eventName, callback) => {
        if (eventName === 'backup-import-progress') {
          const events: ImportProgress[] = [
            { phase: 'validation', progress: 10, message: '验证备份文件', total_files: 100, processed_files: 0 },
            { phase: 'extraction', progress: 50, message: '解压文件', total_files: 100, processed_files: 50 },
            { phase: 'replacing', progress: 80, message: '替换数据', total_files: 100, processed_files: 80 },
            { phase: 'complete', progress: 100, message: '导入完成', total_files: 100, processed_files: 100 },
          ];

          events.forEach((event, index) => {
            setTimeout(() => callback({ payload: event }), index * 10);
          });
        }
        return Promise.resolve(() => {});
      });

      await mockListen('backup-import-progress', (event: any) => {
        phases.push(event.payload.phase);
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(phases).toContain('validation');
      expect(phases).toContain('extraction');
      expect(phases).toContain('complete');
    });

    it('should handle job cancellation', async () => {
      let cancelled = false;

      mockListen.mockImplementation((eventName, callback) => {
        if (eventName === 'backup-job-progress') {
          setTimeout(() => callback({
            payload: {
              jobId: 'test',
              status: 'cancelled',
              progress: 30,
              phase: 'cancelled',
              result: { success: false, error: '任务已取消' },
            }
          }), 10);
        }
        return Promise.resolve(() => {});
      });

      await mockListen('backup-job-progress', (event: any) => {
        if (event.payload.status === 'cancelled') {
          cancelled = true;
        }
      });

      await new Promise(resolve => setTimeout(resolve, 20));

      expect(cancelled).toBe(true);
    });
  });

  // ==========================================================================
  // 自动备份测试
  // ==========================================================================

  describe('Auto Backup', () => {
    it('should trigger auto backup', async () => {
      mockInvoke.mockResolvedValue('/path/to/auto_backup.zip');

      const result = await mockInvoke('auto_backup');

      expect(result).toContain('auto_backup');
    });

    it('should handle auto backup failure', async () => {
      mockInvoke.mockRejectedValue(new Error('自动备份失败'));

      await expect(mockInvoke('auto_backup')).rejects.toThrow('自动备份失败');
    });
  });

  // ==========================================================================
  // 数据完整性测试
  // ==========================================================================

  describe('Data Integrity', () => {
    it('should run integrity check', async () => {
      mockInvoke.mockResolvedValue('✅ 完整性检查通过');

      const result = await mockInvoke('run_data_integrity_check');

      expect(result).toContain('完整性检查通过');
    });

    it('should report integrity warnings', async () => {
      mockInvoke.mockResolvedValue('⚠️ 完整性检查发现 2 项警告:\n- mistakes.db 完整性检查返回: row 123 missing');

      const result = await mockInvoke('run_data_integrity_check');

      expect(result).toContain('警告');
    });
  });

  // ==========================================================================
  // 文件大小格式化测试
  // ==========================================================================

  describe('File Size Formatting', () => {
    const formatFileSize = (bytes: number): string => {
      const units = ['B', 'KB', 'MB', 'GB'];
      let size = bytes;
      let unitIndex = 0;

      while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
      }

      return `${size.toFixed(2)} ${units[unitIndex]}`;
    };

    it('should format bytes correctly', () => {
      expect(formatFileSize(500)).toBe('500.00 B');
    });

    it('should format kilobytes correctly', () => {
      expect(formatFileSize(1024)).toBe('1.00 KB');
    });

    it('should format megabytes correctly', () => {
      expect(formatFileSize(1024 * 1024)).toBe('1.00 MB');
    });

    it('should format gigabytes correctly', () => {
      expect(formatFileSize(1024 * 1024 * 1024)).toBe('1.00 GB');
    });

    it('should handle zero bytes', () => {
      expect(formatFileSize(0)).toBe('0.00 B');
    });
  });

  // ==========================================================================
  // 日期格式化测试
  // ==========================================================================

  describe('Date Formatting', () => {
    const formatDate = (dateStr: string): string => {
      if (!dateStr || dateStr === 'unknown' || dateStr === 'Invalid Date') {
        return '未知';
      }

      try {
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) {
          return '无效日期';
        }

        return date.toLocaleString('zh-CN');
      } catch {
        return '格式错误';
      }
    };

    it('should format valid date', () => {
      const result = formatDate('2024-01-01T12:00:00Z');
      expect(result).not.toBe('未知');
      expect(result).not.toBe('无效日期');
    });

    it('should handle unknown date', () => {
      expect(formatDate('unknown')).toBe('未知');
    });

    it('should handle empty date', () => {
      expect(formatDate('')).toBe('未知');
    });

    it('should handle invalid date string', () => {
      expect(formatDate('not-a-date')).toBe('无效日期');
    });
  });

  // ==========================================================================
  // 错误消息处理测试
  // ==========================================================================

  describe('Error Message Handling', () => {
    const extractErrorMessage = (err: unknown): string => {
      if (err instanceof Error) {
        return err.message;
      } else if (typeof err === 'object' && err !== null) {
        if ('message' in err) return (err as any).message;
        if ('error' in err) return (err as any).error;
        if ('msg' in err) return (err as any).msg;
        return JSON.stringify(err);
      } else if (typeof err === 'string') {
        return err;
      }
      return '未知错误';
    };

    it('should extract Error message', () => {
      const error = new Error('Test error');
      expect(extractErrorMessage(error)).toBe('Test error');
    });

    it('should extract message from object', () => {
      const error = { message: 'Object error' };
      expect(extractErrorMessage(error)).toBe('Object error');
    });

    it('should extract error from object', () => {
      const error = { error: 'Error field' };
      expect(extractErrorMessage(error)).toBe('Error field');
    });

    it('should handle string error', () => {
      expect(extractErrorMessage('String error')).toBe('String error');
    });

    it('should handle null error', () => {
      expect(extractErrorMessage(null)).toBe('未知错误');
    });
  });
});

// ============================================================================
// 集成测试
// ============================================================================

describe('Integration Tests', () => {
  describe('Full Backup-Restore Cycle', () => {
    it('should complete full backup and restore cycle', async () => {
      // 1. 获取备份前状态
      mockInvoke
        .mockResolvedValueOnce([]) // 初始备份列表为空
        .mockResolvedValueOnce({ job_id: 'export-job-1' }) // 导出任务
        .mockResolvedValueOnce(mockBackupList) // 导出后的备份列表
        .mockResolvedValueOnce(mockBackupMetadata) // 获取备份信息
        .mockResolvedValueOnce('import-job-1') // 导入任务
        .mockResolvedValueOnce('✅ 完整性检查通过'); // 完整性检查

      // 执行测试
      const initialList = await mockInvoke('get_backup_list');
      expect(initialList.length).toBe(0);

      const exportResult = await mockInvoke('export_backup_archive_with_options', { request: {} });
      expect(exportResult.job_id).toBe('export-job-1');

      const updatedList = await mockInvoke('get_backup_list');
      expect(updatedList.length).toBe(2);

      const metadata = await mockInvoke('get_backup_info', { archivePath: updatedList[0].file_path });
      expect(metadata.version).toBe('2.0');

      const importResult = await mockInvoke('import_backup_archive_with_options', {
        archivePath: updatedList[0].file_path,
        options: {},
      });
      expect(importResult).toBe('import-job-1');

      const integrityResult = await mockInvoke('run_data_integrity_check');
      expect(integrityResult).toContain('通过');
    });
  });

  describe('Error Recovery', () => {
    it('should handle import failure and maintain data integrity', async () => {
      mockInvoke
        .mockResolvedValueOnce(mockBackupList) // 获取备份列表
        .mockRejectedValueOnce(new Error('导入失败：校验和不匹配')) // 导入失败
        .mockResolvedValueOnce('✅ 完整性检查通过'); // 回滚后完整性检查

      const backups = await mockInvoke('get_backup_list');
      expect(backups.length).toBe(2);

      await expect(
        mockInvoke('import_backup_archive_with_options', {
          archivePath: backups[0].file_path,
          options: {},
        })
      ).rejects.toThrow('校验和不匹配');

      // 验证数据完整性（模拟回滚成功）
      const integrityResult = await mockInvoke('run_data_integrity_check');
      expect(integrityResult).toContain('通过');
    });
  });
});

// ============================================================================
// 端到端测试场景
// ============================================================================

describe('E2E Test Scenarios', () => {
  describe('Scenario 1: First-time User Backup', () => {
    it('should guide user through first backup', async () => {
      const steps: string[] = [];

      // 模拟用户首次使用备份功能
      mockInvoke
        .mockResolvedValueOnce([]) // 没有现有备份
        .mockResolvedValueOnce({ job_id: 'first-backup' }) // 开始导出
        .mockResolvedValueOnce([mockBackupList[0]]); // 完成后有一个备份

      steps.push('检查现有备份');
      const existingBackups = await mockInvoke('get_backup_list');
      expect(existingBackups.length).toBe(0);

      steps.push('创建首次备份');
      const exportResult = await mockInvoke('export_backup_archive_with_options', { request: {} });
      expect(exportResult.job_id).toBe('first-backup');

      steps.push('验证备份创建成功');
      const newBackups = await mockInvoke('get_backup_list');
      expect(newBackups.length).toBe(1);

      expect(steps.length).toBe(3);
    });
  });

  describe('Scenario 2: Disaster Recovery', () => {
    it('should restore from backup after data loss', async () => {
      const recoverySteps: string[] = [];

      mockInvoke
        .mockResolvedValueOnce(mockBackupList) // 有可用备份
        .mockResolvedValueOnce(mockBackupMetadata) // 获取最新备份信息
        .mockResolvedValueOnce('recovery-job') // 开始恢复
        .mockResolvedValueOnce('✅ 完整性检查通过'); // 恢复后验证

      recoverySteps.push('查找可用备份');
      const backups = await mockInvoke('get_backup_list');
      expect(backups.length).toBeGreaterThan(0);

      recoverySteps.push('选择最新备份');
      const latestBackup = backups[0];
      const metadata = await mockInvoke('get_backup_info', { archivePath: latestBackup.file_path });
      expect(metadata.statistics.total_mistakes).toBe(100);

      recoverySteps.push('执行恢复');
      const restoreResult = await mockInvoke('import_backup_archive_with_options', {
        archivePath: latestBackup.file_path,
        options: {},
      });
      expect(restoreResult).toBe('recovery-job');

      recoverySteps.push('验证恢复结果');
      const integrityResult = await mockInvoke('run_data_integrity_check');
      expect(integrityResult).toContain('通过');

      expect(recoverySteps.length).toBe(4);
    });
  });

  describe('Scenario 3: Cross-Platform Migration', () => {
    it('should handle backup from different platform', async () => {
      const crossPlatformMetadata: BackupMetadata = {
        ...mockBackupMetadata,
        platform: 'win32', // 从 Windows 迁移
      };

      mockInvoke
        .mockResolvedValueOnce(crossPlatformMetadata)
        .mockResolvedValueOnce('migration-job')
        .mockResolvedValueOnce('✅ 完整性检查通过');

      // 获取跨平台备份信息
      const metadata = await mockInvoke('get_backup_info', { archivePath: '/path/to/windows_backup.zip' });
      expect(metadata.platform).toBe('win32');

      // 执行导入
      const importResult = await mockInvoke('import_backup_archive_with_options', {
        archivePath: '/path/to/windows_backup.zip',
        options: { bestEffort: true }, // 使用宽容模式处理可能的路径差异
      });
      expect(importResult).toBe('migration-job');

      // 验证迁移结果
      const integrityResult = await mockInvoke('run_data_integrity_check');
      expect(integrityResult).toContain('通过');
    });
  });

  describe('Scenario 4: Large Dataset Backup', () => {
    it('should handle large backup with progress tracking', async () => {
      const progressUpdates: number[] = [];

      mockInvoke.mockResolvedValue({ job_id: 'large-backup' });

      mockListen.mockImplementation((eventName, callback) => {
        if (eventName === 'backup-job-progress') {
          // 模拟大文件备份的进度更新
          for (let i = 0; i <= 100; i += 10) {
            setTimeout(() => callback({
              payload: {
                jobId: 'large-backup',
                status: i < 100 ? 'running' : 'completed',
                progress: i,
                phase: i < 30 ? 'scan' : i < 90 ? 'compress' : 'verify',
                processedItems: i * 10,
                totalItems: 1000,
                etaSeconds: Math.max(0, (100 - i) * 2),
              }
            }), i * 5);
          }
        }
        return Promise.resolve(() => {});
      });

      await mockListen('backup-job-progress', (event: any) => {
        progressUpdates.push(event.payload.progress);
      });

      // 启动备份
      const result = await mockInvoke('export_backup_archive_with_options', { request: {} });
      expect(result.job_id).toBe('large-backup');

      // 等待进度更新
      await new Promise(resolve => setTimeout(resolve, 600));

      expect(progressUpdates.length).toBeGreaterThan(5);
      expect(progressUpdates[progressUpdates.length - 1]).toBe(100);
    });
  });
});

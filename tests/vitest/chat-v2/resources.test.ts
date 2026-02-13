/**
 * Chat V2 - 资源库单元测试
 *
 * 测试资源库 API 和工具函数的行为
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  // Mock API
  MockResourceStoreApi,
  // 工具函数
  calculateHash,
  calculateStringHash,
  calculateBufferHash,
  generateResourceId,
  arrayBufferToBase64,
  base64ToArrayBuffer,
  validateFileSize,
  getFileSizeLimitText,
  formatFileSize,
  getResourceTypeFromMime,
  isImageMimeType,
  isTextMimeType,
  // 常量
  IMAGE_SIZE_LIMIT,
  FILE_SIZE_LIMIT,
  // 便捷方法
  createResourceRef,
  getResourceWithFallback,
  // 类型
  type Resource,
  type ContextRef,
} from '@/chat-v2/resources';
import { ResourceSizeLimitError } from '@/chat-v2/resources/api';

// ============================================================================
// Hash 计算测试
// ============================================================================

describe('Hash Calculation', () => {
  it('calculateStringHash should return consistent hash', async () => {
    const content = 'Hello, World!';
    const hash1 = await calculateStringHash(content);
    const hash2 = await calculateStringHash(content);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex string
  });

  it('calculateStringHash should return different hash for different content', async () => {
    const hash1 = await calculateStringHash('Hello');
    const hash2 = await calculateStringHash('World');

    expect(hash1).not.toBe(hash2);
  });

  it('calculateBufferHash should return consistent hash', async () => {
    const buffer = new TextEncoder().encode('Test content').buffer as ArrayBuffer;
    const hash1 = await calculateBufferHash(buffer);
    const hash2 = await calculateBufferHash(buffer);

    expect(hash1).toBe(hash2);
  });

  it('calculateHash should handle both string and ArrayBuffer', async () => {
    const content = 'Test content';
    const stringHash = await calculateHash(content);

    const buffer = new TextEncoder().encode(content).buffer as ArrayBuffer;
    const bufferHash = await calculateHash(buffer);

    expect(stringHash).toBe(bufferHash);
  });
});

// ============================================================================
// ID 生成测试
// ============================================================================

describe('ID Generation', () => {
  it('generateResourceId should return correct format', () => {
    const id = generateResourceId();

    expect(id).toMatch(/^res_[a-zA-Z0-9_-]{10}$/);
  });

  it('generateResourceId should return unique IDs', () => {
    const ids = new Set<string>();

    for (let i = 0; i < 100; i++) {
      ids.add(generateResourceId());
    }

    expect(ids.size).toBe(100);
  });
});

// ============================================================================
// 数据转换测试
// ============================================================================

describe('Data Conversion', () => {
  it('arrayBufferToBase64 and base64ToArrayBuffer should be reversible', () => {
    const original = 'Hello, World!';
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const buffer = encoder.encode(original).buffer as ArrayBuffer;
    const base64 = arrayBufferToBase64(buffer);
    const restored = base64ToArrayBuffer(base64);
    const decoded = decoder.decode(restored);

    expect(decoded).toBe(original);
  });

  it('base64ToArrayBuffer should handle empty string', () => {
    const buffer = base64ToArrayBuffer('');
    expect(buffer.byteLength).toBe(0);
  });
});

// ============================================================================
// 验证函数测试
// ============================================================================

describe('Validation Functions', () => {
  describe('validateFileSize', () => {
    it('should accept files within limit', () => {
      expect(validateFileSize(1024, 'image')).toBe(true);
      expect(validateFileSize(IMAGE_SIZE_LIMIT, 'image')).toBe(true);
      expect(validateFileSize(FILE_SIZE_LIMIT, 'file')).toBe(true);
    });

    it('should reject files exceeding limit', () => {
      expect(validateFileSize(IMAGE_SIZE_LIMIT + 1, 'image')).toBe(false);
      expect(validateFileSize(FILE_SIZE_LIMIT + 1, 'file')).toBe(false);
    });

    it('should use file limit for non-image types', () => {
      expect(validateFileSize(IMAGE_SIZE_LIMIT + 1, 'note')).toBe(true);
      expect(validateFileSize(FILE_SIZE_LIMIT + 1, 'note')).toBe(false);
    });
  });

  describe('getFileSizeLimitText', () => {
    it('should return correct limit text', () => {
      expect(getFileSizeLimitText('image')).toBe('10MB');
      expect(getFileSizeLimitText('file')).toBe('50MB');
    });
  });

  describe('formatFileSize', () => {
    it('should format bytes correctly', () => {
      expect(formatFileSize(500)).toBe('500 B');
      expect(formatFileSize(1024)).toBe('1.0 KB');
      expect(formatFileSize(1536)).toBe('1.5 KB');
      expect(formatFileSize(1048576)).toBe('1.00 MB');
      expect(formatFileSize(2621440)).toBe('2.50 MB');
    });
  });
});

// ============================================================================
// 类型判断测试
// ============================================================================

describe('Type Detection', () => {
  describe('getResourceTypeFromMime', () => {
    it('should detect image types', () => {
      expect(getResourceTypeFromMime('image/png')).toBe('image');
      expect(getResourceTypeFromMime('image/jpeg')).toBe('image');
      expect(getResourceTypeFromMime('image/gif')).toBe('image');
    });

    it('should return file for non-image types', () => {
      expect(getResourceTypeFromMime('application/pdf')).toBe('file');
      expect(getResourceTypeFromMime('text/plain')).toBe('file');
    });
  });

  describe('isImageMimeType', () => {
    it('should correctly identify image types', () => {
      expect(isImageMimeType('image/png')).toBe(true);
      expect(isImageMimeType('image/jpeg')).toBe(true);
      expect(isImageMimeType('application/pdf')).toBe(false);
    });
  });

  describe('isTextMimeType', () => {
    it('should correctly identify text types', () => {
      expect(isTextMimeType('text/plain')).toBe(true);
      expect(isTextMimeType('text/html')).toBe(true);
      expect(isTextMimeType('application/json')).toBe(true);
      expect(isTextMimeType('application/xml')).toBe(true);
      expect(isTextMimeType('application/javascript')).toBe(true);
      expect(isTextMimeType('application/pdf')).toBe(false);
      expect(isTextMimeType('image/png')).toBe(false);
    });
  });
});

// ============================================================================
// Mock API 测试
// ============================================================================

describe('MockResourceStoreApi', () => {
  let api: MockResourceStoreApi;

  beforeEach(() => {
    api = new MockResourceStoreApi();
    api._clear();
  });

  describe('createOrReuse', () => {
    it('should create new resource', async () => {
      const result = await api.createOrReuse({
        type: 'note',
        data: 'Test note content',
        sourceId: 'note_123',
        metadata: { title: 'Test Note' },
      });

      expect(result.resourceId).toMatch(/^res_/);
      expect(result.hash).toHaveLength(64);
      expect(result.isNew).toBe(true);
    });

    it('should reuse existing resource with same hash', async () => {
      const content = 'Identical content';

      const result1 = await api.createOrReuse({
        type: 'note',
        data: content,
      });

      const result2 = await api.createOrReuse({
        type: 'note',
        data: content,
      });

      expect(result1.hash).toBe(result2.hash);
      expect(result1.resourceId).toBe(result2.resourceId);
      expect(result1.isNew).toBe(true);
      expect(result2.isNew).toBe(false);
    });

    it('should reject files exceeding size limit', async () => {
      const largeContent = 'x'.repeat(IMAGE_SIZE_LIMIT + 1);

      await expect(
        api.createOrReuse({
          type: 'image',
          data: largeContent,
        })
      ).rejects.toThrow(ResourceSizeLimitError);
    });

    it('should set refCount to 0 for new resources', async () => {
      const result = await api.createOrReuse({
        type: 'note',
        data: 'Test content',
      });

      const resource = api._getResource(result.resourceId);
      expect(resource?.refCount).toBe(0);
    });
  });

  describe('get', () => {
    it('should return resource with matching hash', async () => {
      const createResult = await api.createOrReuse({
        type: 'note',
        data: 'Test content',
        sourceId: 'note_123',
      });

      const resource = await api.get(createResult.resourceId, createResult.hash);

      expect(resource).not.toBeNull();
      expect(resource?.id).toBe(createResult.resourceId);
      expect(resource?.hash).toBe(createResult.hash);
      expect(resource?.type).toBe('note');
      expect(resource?.sourceId).toBe('note_123');
    });

    it('should return null for non-existent resource', async () => {
      const resource = await api.get('res_nonexistent', 'fake_hash');
      expect(resource).toBeNull();
    });

    it('should return null for hash mismatch', async () => {
      const createResult = await api.createOrReuse({
        type: 'note',
        data: 'Test content',
      });

      const resource = await api.get(createResult.resourceId, 'wrong_hash');
      expect(resource).toBeNull();
    });
  });

  describe('getLatest', () => {
    it('should return resource regardless of hash', async () => {
      const createResult = await api.createOrReuse({
        type: 'note',
        data: 'Test content',
      });

      const resource = await api.getLatest(createResult.resourceId);

      expect(resource).not.toBeNull();
      expect(resource?.id).toBe(createResult.resourceId);
    });

    it('should return null for non-existent resource', async () => {
      const resource = await api.getLatest('res_nonexistent');
      expect(resource).toBeNull();
    });
  });

  describe('exists', () => {
    it('should return true for existing resource', async () => {
      const createResult = await api.createOrReuse({
        type: 'note',
        data: 'Test content',
      });

      expect(await api.exists(createResult.resourceId)).toBe(true);
    });

    it('should return false for non-existent resource', async () => {
      expect(await api.exists('res_nonexistent')).toBe(false);
    });
  });

  describe('incrementRef / decrementRef', () => {
    it('should increment refCount', async () => {
      const createResult = await api.createOrReuse({
        type: 'note',
        data: 'Test content',
      });

      await api.incrementRef(createResult.resourceId);
      expect(api._getResource(createResult.resourceId)?.refCount).toBe(1);

      await api.incrementRef(createResult.resourceId);
      expect(api._getResource(createResult.resourceId)?.refCount).toBe(2);
    });

    it('should decrement refCount', async () => {
      const createResult = await api.createOrReuse({
        type: 'note',
        data: 'Test content',
      });

      await api.incrementRef(createResult.resourceId);
      await api.incrementRef(createResult.resourceId);
      await api.decrementRef(createResult.resourceId);

      expect(api._getResource(createResult.resourceId)?.refCount).toBe(1);
    });

    it('should not go below 0', async () => {
      const createResult = await api.createOrReuse({
        type: 'note',
        data: 'Test content',
      });

      await api.decrementRef(createResult.resourceId);
      await api.decrementRef(createResult.resourceId);

      expect(api._getResource(createResult.resourceId)?.refCount).toBe(0);
    });

    it('should throw for non-existent resource', async () => {
      await expect(api.incrementRef('res_nonexistent')).rejects.toThrow();
      await expect(api.decrementRef('res_nonexistent')).rejects.toThrow();
    });
  });

  describe('getVersionsBySource', () => {
    it('should return all versions for sourceId', async () => {
      const sourceId = 'note_123';

      await api.createOrReuse({
        type: 'note',
        data: 'Version 1',
        sourceId,
      });

      await api.createOrReuse({
        type: 'note',
        data: 'Version 2',
        sourceId,
      });

      await api.createOrReuse({
        type: 'note',
        data: 'Version 3',
        sourceId,
      });

      const versions = await api.getVersionsBySource(sourceId);

      expect(versions.length).toBe(3);
      versions.forEach((v: Resource) => {
        expect(v.sourceId).toBe(sourceId);
      });
    });

    it('should return empty array for non-existent sourceId', async () => {
      const versions = await api.getVersionsBySource('nonexistent');
      expect(versions).toEqual([]);
    });

    it('should return versions sorted by createdAt descending', async () => {
      const sourceId = 'note_123';

      await api.createOrReuse({
        type: 'note',
        data: 'First',
        sourceId,
      });

      // 添加一点延迟确保时间戳不同
      await new Promise((r) => setTimeout(r, 10));

      await api.createOrReuse({
        type: 'note',
        data: 'Second',
        sourceId,
      });

      const versions = await api.getVersionsBySource(sourceId);

      expect(versions[0].createdAt).toBeGreaterThanOrEqual(versions[1].createdAt);
    });
  });
});

// ============================================================================
// 便捷方法测试
// ============================================================================

describe('Convenience Functions', () => {
  // 注意：这些测试使用默认导出的 resourceStoreApi（Mock 实现）
  // 需要在每个测试前清理状态

  describe('createResourceRef', () => {
    it('should create resource and return ContextRef', async () => {
      const ref = await createResourceRef(
        'note',
        'Test note content',
        'note_123',
        { title: 'Test' }
      );

      expect(ref.resourceId).toMatch(/^res_/);
      expect(ref.hash).toHaveLength(64);
      expect(ref.typeId).toBe('note');
    });
  });

  describe('getResourceWithFallback', () => {
    it('should return exact version when available', async () => {
      const ref = await createResourceRef('note', 'Test content');

      const { resource, isLatestVersion } = await getResourceWithFallback(ref);

      expect(resource).not.toBeNull();
      expect(resource?.hash).toBe(ref.hash);
      expect(isLatestVersion).toBe(true);
    });

    it('should return latest version as fallback', async () => {
      // 创建资源
      const ref = await createResourceRef('note', 'Test content');

      // 修改 hash 模拟版本不匹配
      const modifiedRef: ContextRef = {
        ...ref,
        hash: 'wrong_hash_that_does_not_exist',
      };

      const { resource, isLatestVersion } = await getResourceWithFallback(modifiedRef);

      expect(resource).not.toBeNull();
      expect(isLatestVersion).toBe(false);
    });

    it('should return null when resource not found', async () => {
      const fakeRef: ContextRef = {
        resourceId: 'res_nonexistent',
        hash: 'fake_hash',
        typeId: 'note',
      };

      const { resource, isLatestVersion } = await getResourceWithFallback(fakeRef);

      expect(resource).toBeNull();
      expect(isLatestVersion).toBe(false);
    });
  });
});

// ============================================================================
// 常量测试
// ============================================================================

describe('Constants', () => {
  it('IMAGE_SIZE_LIMIT should be 10MB', () => {
    expect(IMAGE_SIZE_LIMIT).toBe(10 * 1024 * 1024);
  });

  it('FILE_SIZE_LIMIT should be 50MB', () => {
    expect(FILE_SIZE_LIMIT).toBe(50 * 1024 * 1024);
  });
});

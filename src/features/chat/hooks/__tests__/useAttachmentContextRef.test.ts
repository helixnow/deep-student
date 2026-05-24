/**
 * Chat V2 - 附件上下文引用管理 Hook 单元测试
 *
 * 测试 Prompt 10 的实现：
 * 1. 验证文件上传时正确创建资源
 * 2. 验证附件移除时正确移除引用
 * 3. 验证清空所有引用功能
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAttachmentContextRef } from '../useAttachmentContextRef';

// ============================================================================
// Mock 设置
// ============================================================================

// Mock resourceStoreApi
vi.mock('../../resources', () => ({
  resourceStoreApi: {
    createOrReuse: vi.fn(),
    get: vi.fn(),
  },
  IMAGE_TYPE_ID: 'image',
  FILE_TYPE_ID: 'file',
}));

// Mock context vfs upload api
vi.mock('../../context', () => ({
  uploadAttachment: vi.fn(),
}));

// Mock context definitions
vi.mock('../../context/definitions/image', () => ({
  IMAGE_TYPE_ID: 'image',
}));

vi.mock('../../context/definitions/file', () => ({
  FILE_TYPE_ID: 'file',
}));

// 获取 mock 引用
import { resourceStoreApi } from '../../resources';
import { uploadAttachment } from '../../context';
const mockCreateOrReuse = vi.mocked(resourceStoreApi.createOrReuse);
const mockUploadAttachment = vi.mocked(uploadAttachment);

// ============================================================================
// 测试数据
// ============================================================================

const createMockStore = () => {
  const contextRefs: Array<{ resourceId: string; hash: string; typeId: string }> = [];
  const state = {
    addContextRef: vi.fn((ref) => {
      contextRefs.push(ref);
    }),
    removeContextRef: vi.fn((resourceId) => {
      const index = contextRefs.findIndex((r) => r.resourceId === resourceId);
      if (index !== -1) {
        contextRefs.splice(index, 1);
      }
    }),
    getContextRefsByType: vi.fn(() => contextRefs),
  };

  return {
    state,
    getState: () => state,
    subscribe: vi.fn(() => () => {}),
    setState: vi.fn(),
  };
};

const createMockFile = (name: string, type: string, size: number = 1024): File => {
  const blob = new Blob(['test content'], { type });
  return new File([blob], name, { type });
};

// ============================================================================
// 测试
// ============================================================================

describe('useAttachmentContextRef', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUploadAttachment.mockResolvedValue({
      sourceId: 'att_default',
      resourceHash: 'hash_att_default',
      isNew: true,
      attachment: {
        id: 1,
        sourceId: 'att_default',
        name: 'default.png',
        mimeType: 'image/png',
        size: 1024,
        storageType: 'resource',
        contentHash: 'hash_att_default',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
  });

  describe('handleFileUpload', () => {
    it('应该创建图片资源并添加上下文引用', async () => {
      const mockStore = createMockStore();
      mockUploadAttachment.mockResolvedValue({
        sourceId: 'att_img_001',
        resourceHash: 'hash_att_img_001',
        isNew: true,
        attachment: {
          id: 11,
          sourceId: 'att_img_001',
          name: 'test.png',
          mimeType: 'image/png',
          size: 1024,
          storageType: 'resource',
          contentHash: 'hash_att_img_001',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });
      mockCreateOrReuse.mockResolvedValue({
        resourceId: 'res_img_001',
        hash: 'hash_img_001',
        isNew: true,
      });

      const { result } = renderHook(() =>
        useAttachmentContextRef({ store: mockStore as any })
      );

      const file = createMockFile('test.png', 'image/png');
      let contextRef;

      await act(async () => {
        contextRef = await result.current.handleFileUpload(file, 'attach_1');
      });

      // 验证创建了正确类型的资源
      expect(mockCreateOrReuse).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'image',
          metadata: expect.objectContaining({
            name: 'test.png',
            mimeType: 'image/png',
          }),
        })
      );

      // 验证返回了正确的 ContextRef
      expect(contextRef).toEqual({
        resourceId: 'res_img_001',
        hash: 'hash_img_001',
        typeId: 'image',
      });
    });

    it('应该创建文件资源并添加上下文引用', async () => {
      const mockStore = createMockStore();
      mockUploadAttachment.mockResolvedValue({
        sourceId: 'att_file_001',
        resourceHash: 'hash_att_file_001',
        isNew: true,
        attachment: {
          id: 22,
          sourceId: 'att_file_001',
          name: 'document.pdf',
          mimeType: 'application/pdf',
          size: 1024,
          storageType: 'resource',
          contentHash: 'hash_att_file_001',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });
      mockCreateOrReuse.mockResolvedValue({
        resourceId: 'res_file_001',
        hash: 'hash_file_001',
        isNew: true,
      });

      const { result } = renderHook(() =>
        useAttachmentContextRef({ store: mockStore as any })
      );

      const file = createMockFile('document.pdf', 'application/pdf');
      let contextRef;

      await act(async () => {
        contextRef = await result.current.handleFileUpload(file, 'attach_2');
      });

      // 验证创建了 file 类型资源
      expect(mockCreateOrReuse).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'file',
        })
      );

      expect(contextRef?.typeId).toBe('file');
    });

    it('应该在 store 不可用时返回 null', async () => {
      const { result } = renderHook(() =>
        useAttachmentContextRef({ store: null })
      );

      const file = createMockFile('test.png', 'image/png');
      let contextRef;

      await act(async () => {
        contextRef = await result.current.handleFileUpload(file);
      });

      expect(contextRef).toBeNull();
      expect(mockCreateOrReuse).not.toHaveBeenCalled();
    });
  });

  describe('handleBase64Upload', () => {
    it('应该从 base64 数据创建资源', async () => {
      const mockStore = createMockStore();
      mockUploadAttachment.mockResolvedValue({
        sourceId: 'att_b64_001',
        resourceHash: 'hash_att_b64_001',
        isNew: true,
        attachment: {
          id: 33,
          sourceId: 'att_b64_001',
          name: 'screenshot.jpg',
          mimeType: 'image/jpeg',
          size: 512,
          storageType: 'resource',
          contentHash: 'hash_att_b64_001',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });
      mockCreateOrReuse.mockResolvedValue({
        resourceId: 'res_b64_001',
        hash: 'hash_b64_001',
        isNew: true,
      });

      const { result } = renderHook(() =>
        useAttachmentContextRef({ store: mockStore as any })
      );

      // 简单的 base64 数据
      const base64Data = btoa('test image data');
      let contextRef;

      await act(async () => {
        contextRef = await result.current.handleBase64Upload(
          base64Data,
          'image/jpeg',
          'screenshot.jpg',
          'attach_3'
        );
      });

      expect(mockCreateOrReuse).toHaveBeenCalled();
      expect(contextRef?.typeId).toBe('image');
    });
  });

  describe('removeAttachmentRef', () => {
    it('应该移除附件的上下文引用', async () => {
      const mockStore = createMockStore();
      const removeContextRef = vi.fn();
      mockStore.state.removeContextRef = removeContextRef;

      mockCreateOrReuse.mockResolvedValue({
        resourceId: 'res_remove_001',
        hash: 'hash_remove_001',
        isNew: true,
      });
      mockUploadAttachment.mockResolvedValue({
        sourceId: 'att_remove_001',
        resourceHash: 'hash_att_remove_001',
        isNew: true,
        attachment: {
          id: 44,
          sourceId: 'att_remove_001',
          name: 'test.png',
          mimeType: 'image/png',
          size: 1024,
          storageType: 'resource',
          contentHash: 'hash_att_remove_001',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });

      const { result } = renderHook(() =>
        useAttachmentContextRef({ store: mockStore as any })
      );

      // 先上传
      const file = createMockFile('test.png', 'image/png');
      await act(async () => {
        await result.current.handleFileUpload(file, 'attach_to_remove');
      });

      // 然后移除
      act(() => {
        result.current.removeAttachmentRef('attach_to_remove');
      });

      expect(removeContextRef).toHaveBeenCalledWith('res_remove_001');
    });

    it('应该支持上传未完成时先移除，再在上传完成后正确移除（防回归）', async () => {
      const mockStore = createMockStore();
      const removeContextRef = vi.fn();
      mockStore.state.removeContextRef = removeContextRef;

      let resolveCreateOrReuse: ((value: { resourceId: string; hash: string; isNew: boolean }) => void) | null = null;
      mockCreateOrReuse.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveCreateOrReuse = resolve;
          })
      );
      mockUploadAttachment.mockResolvedValue({
        sourceId: 'att_async_001',
        resourceHash: 'hash_att_async_001',
        isNew: true,
        attachment: {
          id: 55,
          sourceId: 'att_async_001',
          name: 'async.png',
          mimeType: 'image/png',
          size: 1024,
          storageType: 'resource',
          contentHash: 'hash_att_async_001',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });

      const { result } = renderHook(() =>
        useAttachmentContextRef({ store: mockStore as any })
      );

      const file = createMockFile('async.png', 'image/png');
      const uploadPromise = act(async () => {
        await result.current.handleFileUpload(file, 'attach_async');
      });

      act(() => {
        result.current.removeAttachmentRef('attach_async');
      });
      expect(removeContextRef).not.toHaveBeenCalled();

      await waitFor(() => {
        expect(resolveCreateOrReuse).toBeTruthy();
      });

      resolveCreateOrReuse?.({
        resourceId: 'res_async_001',
        hash: 'hash_async_001',
        isNew: true,
      });
      await uploadPromise;

      act(() => {
        result.current.removeAttachmentRef('attach_async');
      });
      expect(removeContextRef).toHaveBeenCalledWith('res_async_001');
    });

    it('应该忽略不存在的附件 ID', () => {
      const mockStore = createMockStore();
      const removeContextRef = vi.fn();
      mockStore.state.removeContextRef = removeContextRef;

      const { result } = renderHook(() =>
        useAttachmentContextRef({ store: mockStore as any })
      );

      act(() => {
        result.current.removeAttachmentRef('non_existent');
      });

      // 不应该调用 removeContextRef
      expect(removeContextRef).not.toHaveBeenCalled();
    });
  });

  describe('clearAllAttachmentRefs', () => {
    it('应该清空所有附件引用', async () => {
      const mockStore = createMockStore();
      const removeContextRef = vi.fn();
      mockStore.state.removeContextRef = removeContextRef;

      let callCount = 0;
      mockUploadAttachment.mockImplementation(async ({ name, mimeType }) => ({
        sourceId: `att_clear_${callCount + 1}`,
        resourceHash: `hash_att_clear_${callCount + 1}`,
        isNew: true,
        attachment: {
          id: 100 + callCount + 1,
          sourceId: `att_clear_${callCount + 1}`,
          name: name || `f_${callCount + 1}`,
          mimeType: mimeType || 'application/octet-stream',
          size: 1024,
          storageType: 'resource',
          contentHash: `hash_att_clear_${callCount + 1}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      }));
      mockCreateOrReuse.mockImplementation(async () => {
        callCount++;
        return {
          resourceId: `res_${callCount}`,
          hash: `hash_${callCount}`,
          isNew: true,
        };
      });

      const { result } = renderHook(() =>
        useAttachmentContextRef({ store: mockStore as any })
      );

      // 上传多个文件
      const file1 = createMockFile('test1.png', 'image/png');
      const file2 = createMockFile('test2.pdf', 'application/pdf');

      await act(async () => {
        await result.current.handleFileUpload(file1, 'attach_1');
        await result.current.handleFileUpload(file2, 'attach_2');
      });

      // 清空所有
      act(() => {
        result.current.clearAllAttachmentRefs();
      });

      expect(removeContextRef).toHaveBeenCalledTimes(2);
    });
  });

  describe('enabled 选项', () => {
    it('应该在 enabled=false 时禁用所有功能', async () => {
      const mockStore = createMockStore();

      const { result } = renderHook(() =>
        useAttachmentContextRef({ store: mockStore as any, enabled: false })
      );

      const file = createMockFile('test.png', 'image/png');
      let contextRef;

      await act(async () => {
        contextRef = await result.current.handleFileUpload(file);
      });

      expect(contextRef).toBeNull();
      expect(mockCreateOrReuse).not.toHaveBeenCalled();
    });
  });
});

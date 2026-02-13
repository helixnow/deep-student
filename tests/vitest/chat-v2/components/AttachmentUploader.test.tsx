/**
 * Chat V2 - AttachmentUploader 单元测试
 *
 * 测试要点：
 * - should add attachment on file select
 * - should reject file exceeding maxSize
 * - should handle drag and drop
 * - should handle paste
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import type { ChatStore, AttachmentMeta } from '@/chat-v2/core/types';
import { createStore } from 'zustand/vanilla';

// Mock VFS / Resource layer（AttachmentUploader 依赖上传到 VFS 并创建资源引用）
vi.mock('@/chat-v2/context/vfsRefApi', () => ({
  vfsRefApi: {
    uploadAttachment: vi.fn(async () => ({
      sourceId: 'src_test',
      resourceHash: 'hash_vfs_test',
      isNew: true,
    })),
  },
}));

vi.mock('@/chat-v2/resources', () => ({
  resourceStoreApi: {
    createOrReuse: vi.fn(async () => ({
      resourceId: 'res_test',
      hash: 'hash_res_test',
      isNew: true,
    })),
  },
}));

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'attachmentUploader.dragOrClick': 'Drag and drop or click to upload',
        'attachmentUploader.dropHere': 'Drop files here',
        'attachmentUploader.supportedFormats': 'Supports images, PDF, documents, etc.',
        'attachmentUploader.maxSize': `Max file size: ${params?.size}`,
        'attachmentUploader.currentCount': `Added ${params?.current}/${params?.max}`,
        'attachmentUploader.types.image': 'Images',
        'attachmentUploader.types.document': 'Documents',
        'attachmentUploader.errors.maxCount': `Maximum ${params?.max} attachments allowed`,
        'attachmentUploader.errors.invalidType': 'File type not supported',
        'attachmentUploader.errors.tooLarge': `File too large, max ${params?.max}`,
        'attachmentUploader.errors.readFailed': 'Failed to read file',
      };
      return translations[key] || key;
    },
  }),
  // Some modules import and use this during i18n initialization.
  initReactI18next: {
    type: '3rdParty',
    init: () => undefined,
  },
}));

let AttachmentUploader: typeof import('@/chat-v2/components/AttachmentUploader').AttachmentUploader;

// ============================================================================
// Mock Store 创建
// ============================================================================

function createMockChatStore(attachments: AttachmentMeta[] = []) {
  const state: Partial<ChatStore> = {
    attachments,
    addAttachment: vi.fn(),
    removeAttachment: vi.fn(),
    clearAttachments: vi.fn(),
    addContextRef: vi.fn(),
  };

  return createStore(() => state) as ReturnType<typeof createStore<ChatStore>>;
}

// ============================================================================
// 辅助函数
// ============================================================================

function createMockFile(name: string, type: string, size: number): File {
  // 使用 Uint8Array 避免 new Array(size).fill(...) 的巨额开销
  // 对于超大文件测试，只需要正确的 size 语义，不需要真实内容
  const bytes = new Uint8Array(Math.min(size, 1024));
  const file = new File([bytes], name, { type });
  if (size > bytes.byteLength) {
    // Blob/File 的 size 是只读 getter，无法可靠覆写；这里通过创建一个更大的 Blob 保证 size
    return new File([new Uint8Array(size)], name, { type });
  }
  return file;
}

function createDataTransfer(files: File[]): DataTransfer {
  const dataTransfer = {
    files,
    items: files.map((file) => ({
      kind: 'file',
      type: file.type,
      getAsFile: () => file,
    })),
    types: ['Files'],
    getData: vi.fn(),
    setData: vi.fn(),
  } as unknown as DataTransfer;
  return dataTransfer;
}

// ============================================================================
// 测试
// ============================================================================

describe('AttachmentUploader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  beforeEach(async () => {
    // 在单 worker/单进程跑全量 suite 时，模块缓存可能被其他用例提前加载；
    // 这里强制重置模块并在 mocks 生效后再导入组件，避免偶发“真实实现被缓存”导致的用例不稳定。
    vi.resetModules();
    ({ AttachmentUploader } = await import('@/chat-v2/components/AttachmentUploader'));
  });

  describe('rendering', () => {
    it('should render drop zone', () => {
      const store = createMockChatStore();

      render(<AttachmentUploader store={store} />);

      expect(screen.getByText('Drag and drop or click to upload')).toBeInTheDocument();
      expect(screen.getByText('Supports images, PDF, documents, etc.')).toBeInTheDocument();
    });

    it('should show max size info', () => {
      const store = createMockChatStore();

      render(<AttachmentUploader store={store} maxSize={5 * 1024 * 1024} />);

      expect(screen.getByText('Max file size: 5.0 MB')).toBeInTheDocument();
    });

    it('should show current attachment count', () => {
      const store = createMockChatStore([
        { id: '1', name: 'test.png', type: 'image', mimeType: 'image/png', size: 1024, status: 'ready' },
      ]);

      render(<AttachmentUploader store={store} maxCount={10} />);

      expect(screen.getByText('Added 1/10')).toBeInTheDocument();
    });
  });

  describe('file selection', () => {
    it('should add attachment on file select', async () => {
      const store = createMockChatStore();
      const mockFile = createMockFile('test.pdf', 'application/pdf', 1024);

      render(<AttachmentUploader store={store} />);

      // 找到隐藏的文件输入
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      expect(fileInput).toBeInTheDocument();

      // 模拟文件选择
      Object.defineProperty(fileInput, 'files', {
        value: [mockFile],
      });
      fireEvent.change(fileInput);

      // 验证 addAttachment 被调用
      await waitFor(() => {
        expect(store.getState().addAttachment).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'test.pdf',
            type: 'document',
            mimeType: 'application/pdf',
            size: 1024,
            status: 'ready',
          })
        );
      });
    });

    it('should reject file exceeding maxSize', async () => {
      const store = createMockChatStore();
      const maxSize = 1024; // 1KB
      const mockFile = createMockFile('large.pdf', 'application/pdf', 2048); // 2KB

      render(<AttachmentUploader store={store} maxSize={maxSize} />);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      Object.defineProperty(fileInput, 'files', {
        value: [mockFile],
      });
      fireEvent.change(fileInput);

      // 验证错误提示显示
      await waitFor(() => {
        expect(screen.getByText(/File too large/i)).toBeInTheDocument();
      });

      // 验证 addAttachment 没有被调用
      expect(store.getState().addAttachment).not.toHaveBeenCalled();
    });

    it('should reject file exceeding maxCount', async () => {
      const existingAttachments: AttachmentMeta[] = [
        { id: '1', name: 'a.png', type: 'image', mimeType: 'image/png', size: 100, status: 'ready' },
        { id: '2', name: 'b.png', type: 'image', mimeType: 'image/png', size: 100, status: 'ready' },
      ];
      const store = createMockChatStore(existingAttachments);
      const mockFile = createMockFile('c.png', 'image/png', 100);

      render(<AttachmentUploader store={store} maxCount={2} />);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      Object.defineProperty(fileInput, 'files', {
        value: [mockFile],
      });
      fireEvent.change(fileInput);

      await waitFor(() => {
        expect(screen.getByText(/Maximum 2 attachments allowed/i)).toBeInTheDocument();
      });

      expect(store.getState().addAttachment).not.toHaveBeenCalled();
    });

    it('should reject unsupported file type', async () => {
      const store = createMockChatStore();
      const mockFile = createMockFile('malware.exe', 'application/x-msdownload', 100);

      render(<AttachmentUploader store={store} acceptTypes={['image/*', 'application/pdf']} />);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      Object.defineProperty(fileInput, 'files', {
        value: [mockFile],
      });
      fireEvent.change(fileInput);

      await waitFor(() => {
        expect(screen.getByText('File type not supported')).toBeInTheDocument();
      });

      expect(store.getState().addAttachment).not.toHaveBeenCalled();
    });
  });

  describe('drag and drop', () => {
    it('should handle drag and drop', async () => {
      const store = createMockChatStore();
      const mockFile = createMockFile('dropped.png', 'image/png', 1024);

      render(<AttachmentUploader store={store} />);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const dropZone = fileInput.nextElementSibling as HTMLElement;

      // 模拟拖拽进入
      fireEvent.dragEnter(dropZone, {
        dataTransfer: createDataTransfer([mockFile]),
      });

      // 验证拖拽状态
      expect(screen.getByText('Drop files here')).toBeInTheDocument();

      // 模拟放置
      fireEvent.drop(dropZone, {
        dataTransfer: createDataTransfer([mockFile]),
      });

      // 验证 addAttachment 被调用
      await waitFor(() => {
        expect(store.getState().addAttachment).toHaveBeenCalled();
      });
    });

    it('should reset drag state on drop', async () => {
      const store = createMockChatStore();

      render(<AttachmentUploader store={store} />);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const dropZone = fileInput.nextElementSibling as HTMLElement;

      fireEvent.dragEnter(dropZone);
      expect(screen.getByText('Drop files here')).toBeInTheDocument();

      // drop 会显式 setIsDragging(false)，比 dragLeave 更稳定（jsdom 的 DragEvent 坐标不可靠）
      fireEvent.drop(dropZone, { dataTransfer: createDataTransfer([]) });

      // 状态应该重置
      await waitFor(() => {
        expect(screen.getByText('Drag and drop or click to upload')).toBeInTheDocument();
      });
    });
  });

  describe('paste', () => {
    it('should handle paste', async () => {
      const store = createMockChatStore();
      const mockFile = createMockFile('pasted.png', 'image/png', 1024);

      render(<AttachmentUploader store={store} />);

      // 模拟粘贴事件
      const clipboardData = {
        items: [
          {
            kind: 'file',
            type: 'image/png',
            getAsFile: () => mockFile,
          },
        ],
      };

      fireEvent.paste(document, {
        clipboardData,
      });

      // 验证 addAttachment 被调用
      await waitFor(() => {
        expect(store.getState().addAttachment).toHaveBeenCalled();
      });
    });
  });

  describe('image preview', () => {
    it('should create preview for image files', async () => {
      const store = createMockChatStore();
      const mockImageFile = createMockFile('photo.jpg', 'image/jpeg', 1024);

      // Mock FileReader
      const mockReadAsDataURL = vi.fn();
      const mockFileReader = {
        readAsDataURL: mockReadAsDataURL,
        onload: null as (() => void) | null,
        onerror: null as (() => void) | null,
        result: 'data:image/jpeg;base64,xxx',
      };
      vi.spyOn(window, 'FileReader').mockImplementation(() => mockFileReader as unknown as FileReader);

      render(<AttachmentUploader store={store} />);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      Object.defineProperty(fileInput, 'files', {
        value: [mockImageFile],
      });
      fireEvent.change(fileInput);

      // 验证 FileReader 被调用
      expect(mockReadAsDataURL).toHaveBeenCalledWith(mockImageFile);

      // 模拟 FileReader 完成
      if (mockFileReader.onload) {
        mockFileReader.onload();
      }

      await waitFor(() => {
        expect(store.getState().addAttachment).toHaveBeenCalledWith(
          expect.objectContaining({
            previewUrl: 'data:image/jpeg;base64,xxx',
          })
        );
      });

      vi.restoreAllMocks();
    });
  });

  describe('error handling', () => {
    it('should clear error on dismiss', async () => {
      const store = createMockChatStore();
      const mockFile = createMockFile('large.pdf', 'application/pdf', 10 * 1024 * 1024 + 1); // 10MB+1

      render(<AttachmentUploader store={store} maxSize={10 * 1024 * 1024} />);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      Object.defineProperty(fileInput, 'files', {
        value: [mockFile],
      });
      fireEvent.change(fileInput);

      // 等待错误显示
      await waitFor(() => {
        expect(screen.getByText(/File too large/i)).toBeInTheDocument();
      });

      // 点击关闭按钮
      const closeButton = screen.getByRole('button');
      if (closeButton) {
        fireEvent.click(closeButton);
      }

      // 错误应该消失
      await waitFor(() => {
        expect(screen.queryByText(/File too large/i)).not.toBeInTheDocument();
      });
    });
  });
});

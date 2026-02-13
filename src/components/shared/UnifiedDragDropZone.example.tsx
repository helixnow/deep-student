/**
 * UnifiedDragDropZone 使用示例
 * 
 * 这个文件提供了统一拖拽组件的实际使用示例
 * 可以作为其他组件的参考模板
 */

import React, { useState } from 'react';
import { UnifiedDragDropZone, FILE_TYPES } from './UnifiedDragDropZone';

/**
 * 示例 1: 简单图片上传
 */
export function SimpleImageUploader() {
  const [images, setImages] = useState<File[]>([]);

  const handleFilesDropped = (files: File[]) => {
    setImages((prev) => [...prev, ...files]);
    console.log('上传的图片:', files);
  };

  return (
    <div className="p-4">
      <h2 className="text-lg font-bold mb-4">图片上传示例</h2>
      
      <UnifiedDragDropZone
        zoneId="simple-image-uploader"
        onFilesDropped={handleFilesDropped}
        acceptedFileTypes={[FILE_TYPES.IMAGE]}
        maxFiles={5}
        maxFileSize={10 * 1024 * 1024} // 10MB
      >
        <div
          className="border-2 border-dashed rounded-lg p-8 text-center"
          style={{
            borderColor: 'hsl(var(--border))',
            backgroundColor: 'hsl(var(--background))',
          }}
        >
          <p style={{ color: 'hsl(var(--foreground))' }}>
            拖放图片到此处
          </p>
          <p
            className="text-sm mt-2"
            style={{ color: 'hsl(var(--muted-foreground))' }}
          >
            支持 JPG, PNG, GIF 等格式，最多 5 张，每张不超过 10MB
          </p>
        </div>
      </UnifiedDragDropZone>

      {images.length > 0 && (
        <div className="mt-4">
          <h3 className="font-medium mb-2">已上传的图片：</h3>
          <ul className="space-y-2">
            {images.map((file, index) => (
              <li key={index} className="flex items-center gap-2">
                <span className="text-sm">{file.name}</span>
                <span className="text-xs text-gray-500">
                  ({(file.size / 1024).toFixed(1)} KB)
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * 示例 2: 聊天附件上传（图片 + 文档）
 */
export function ChatAttachmentUploader() {
  const [attachments, setAttachments] = useState<File[]>([]);
  const [errorMessage, setErrorMessage] = useState<string>('');

  const handleFilesDropped = (files: File[]) => {
    setAttachments((prev) => [...prev, ...files]);
    setErrorMessage('');
  };

  const handleError = (error: string) => {
    setErrorMessage(error);
  };

  const handleValidationError = (error: string, rejectedFiles: string[]) => {
    setErrorMessage(`${error}\n被拒绝的文件: ${rejectedFiles.join(', ')}`);
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="p-4">
      <h2 className="text-lg font-bold mb-4">聊天附件上传示例</h2>

      <UnifiedDragDropZone
        zoneId="chat-attachments"
        onFilesDropped={handleFilesDropped}
        acceptedFileTypes={[FILE_TYPES.IMAGE, FILE_TYPES.DOCUMENT]}
        maxFiles={20}
        maxFileSize={50 * 1024 * 1024} // 50MB
        showOverlay={true}
        onError={handleError}
        onValidationError={handleValidationError}
      >
        <div
          className="border rounded-lg p-4"
          style={{
            borderColor: 'hsl(var(--border))',
            backgroundColor: 'hsl(var(--background))',
          }}
        >
          <textarea
            className="w-full p-2 border rounded resize-none"
            placeholder="输入消息..."
            rows={4}
            style={{
              borderColor: 'hsl(var(--border))',
              backgroundColor: 'hsl(var(--input))',
              color: 'hsl(var(--foreground))',
            }}
          />

          {attachments.length > 0 && (
            <div className="mt-4 space-y-2">
              <h3 className="text-sm font-medium">附件：</h3>
              {attachments.map((file, index) => (
                <div
                  key={index}
                  className="flex items-center justify-between p-2 rounded"
                  style={{
                    backgroundColor: 'hsl(var(--muted))',
                  }}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm">{file.name}</span>
                    <span className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
                      ({(file.size / 1024).toFixed(1)} KB)
                    </span>
                  </div>
                  <button
                    onClick={() => removeAttachment(index)}
                    className="text-xs px-2 py-1 rounded"
                    style={{
                      backgroundColor: 'hsl(var(--destructive))',
                      color: 'hsl(var(--destructive-foreground))',
                    }}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          )}

          {errorMessage && (
            <div
              className="mt-4 p-3 rounded text-sm"
              style={{
                backgroundColor: 'hsl(var(--destructive) / 0.1)',
                color: 'hsl(var(--destructive))',
              }}
            >
              {errorMessage}
            </div>
          )}
        </div>
      </UnifiedDragDropZone>
    </div>
  );
}

/**
 * 示例 3: 自定义拖拽状态样式
 */
export function CustomStyleUploader() {
  const [isDragging, setIsDragging] = useState(false);
  const [files, setFiles] = useState<File[]>([]);

  return (
    <div className="p-4">
      <h2 className="text-lg font-bold mb-4">自定义样式示例</h2>

      <UnifiedDragDropZone
        zoneId="custom-style-uploader"
        onFilesDropped={setFiles}
        acceptedFileTypes={[FILE_TYPES.ALL]}
        onDragStateChange={setIsDragging}
        showOverlay={false} // 不显示默认覆盖层
      >
        <div
          className="transition-all duration-200 rounded-lg p-8 text-center"
          style={{
            backgroundColor: isDragging
              ? 'hsl(var(--primary) / 0.1)'
              : 'hsl(var(--background))',
            border: isDragging
              ? '2px solid hsl(var(--primary))'
              : '2px dashed hsl(var(--border))',
            transform: isDragging ? 'scale(1.02)' : 'scale(1)',
          }}
        >
          <div className="text-4xl mb-4">
            {isDragging ? '📥' : '📁'}
          </div>
          <p
            className="text-lg font-medium"
            style={{ color: 'hsl(var(--foreground))' }}
          >
            {isDragging ? '松开鼠标上传文件' : '拖放任意文件到此处'}
          </p>
          <p
            className="text-sm mt-2"
            style={{ color: 'hsl(var(--muted-foreground))' }}
          >
            或点击选择文件
          </p>
        </div>
      </UnifiedDragDropZone>

      {files.length > 0 && (
        <div className="mt-4">
          <p className="text-sm">
            已选择 <strong>{files.length}</strong> 个文件
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * 示例 4: 多个独立的拖拽区域
 */
export function MultipleZonesExample() {
  const [mainImages, setMainImages] = useState<File[]>([]);
  const [thumbnails, setThumbnails] = useState<File[]>([]);

  return (
    <div className="p-4">
      <h2 className="text-lg font-bold mb-4">多拖拽区域示例</h2>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* 主图上传 */}
        <div>
          <h3 className="text-sm font-medium mb-2">主图（最多1张）</h3>
          <UnifiedDragDropZone
            zoneId="main-image-zone"
            onFilesDropped={(files) => setMainImages(files.slice(0, 1))}
            acceptedFileTypes={[FILE_TYPES.IMAGE]}
            maxFiles={1}
            maxFileSize={5 * 1024 * 1024}
          >
            <div
              className="border-2 border-dashed rounded-lg p-6 text-center h-48 flex items-center justify-center"
              style={{
                borderColor: 'hsl(var(--border))',
                backgroundColor: 'hsl(var(--background))',
              }}
            >
              {mainImages.length > 0 ? (
                <p className="text-sm">{mainImages[0].name}</p>
              ) : (
                <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  拖放主图到此处
                </p>
              )}
            </div>
          </UnifiedDragDropZone>
        </div>

        {/* 缩略图上传 */}
        <div>
          <h3 className="text-sm font-medium mb-2">缩略图（最多5张）</h3>
          <UnifiedDragDropZone
            zoneId="thumbnails-zone"
            onFilesDropped={setThumbnails}
            acceptedFileTypes={[FILE_TYPES.IMAGE]}
            maxFiles={5}
            maxFileSize={2 * 1024 * 1024}
          >
            <div
              className="border-2 border-dashed rounded-lg p-6 text-center h-48 flex items-center justify-center"
              style={{
                borderColor: 'hsl(var(--border))',
                backgroundColor: 'hsl(var(--background))',
              }}
            >
              {thumbnails.length > 0 ? (
                <p className="text-sm">已添加 {thumbnails.length} 张缩略图</p>
              ) : (
                <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  拖放缩略图到此处
                </p>
              )}
            </div>
          </UnifiedDragDropZone>
        </div>
      </div>
    </div>
  );
}


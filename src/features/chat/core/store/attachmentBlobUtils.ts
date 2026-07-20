/**
 * 附件 Blob URL 释放工具
 *
 * store 中所有「直接把 attachments 置空」的路径（发送、会话重置、会话恢复）
 * 必须先释放 blob: 预览 URL，否则每次带附件发送都会永久泄漏
 * 一个持有完整文件字节的 Blob（P1 内存泄漏修复）。
 *
 * clearAttachments() action 已自带释放逻辑；本工具供绕过该 action 的
 * set({ attachments: [] }) 调用点复用。
 */

interface AttachmentWithPreview {
  previewUrl?: string;
}

export function revokeAttachmentBlobUrls(attachments: readonly AttachmentWithPreview[]): void {
  for (const attachment of attachments) {
    if (attachment.previewUrl?.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(attachment.previewUrl);
      } catch {
        // 非浏览器环境（测试）或重复释放：忽略
      }
    }
  }
}

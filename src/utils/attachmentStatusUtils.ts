import { buildAttachmentKey } from './attachmentKey';

// 🎯 旧架构类型内联（原从 chathost/hooks/useAttachments 导入）
export type DocParseStatus = {
  status: 'processing' | 'success' | 'error';
  error?: string;
};

export type AttachmentStatus = 'processing' | 'success' | 'error' | undefined;

/**
 * 解析附件文件的状态
 * @param file 附件文件
 * @param docParseStatuses 文档解析状态记录
 * @returns 附件状态
 */
export function resolveAttachmentStatus(
  file: File,
  docParseStatuses: Record<string, DocParseStatus>
): AttachmentStatus {
  const key = buildAttachmentKey(file.name, file.size, file.type);
  return docParseStatuses[key]?.status as AttachmentStatus;
}

/**
 * 检查是否有文档尚未准备就绪（解析未完成或失败）
 * @param files 附件文件列表
 * @param docParseStatuses 文档解析状态记录
 * @returns 是否有文档未准备就绪
 */
export function isAnyDocNotReady(
  files: File[], 
  docParseStatuses: Record<string, DocParseStatus>
): boolean {
  const docs = files.filter(f => !f.type.startsWith('image/'));
  return docs.some(d => {
    const key = buildAttachmentKey(d.name, d.size, d.type);
    return docParseStatuses[key]?.status !== 'success';
  });
}

/**
 * 获取文档解析状态分布统计
 * @param files 附件文件列表
 * @param docParseStatuses 文档解析状态记录
 * @returns 状态分布计数对象
 */
export function getDocParseStatusDistribution(
  files: File[], 
  docParseStatuses: Record<string, DocParseStatus>
): { processing: number; success: number; error: number; pending: number } {
  const docs = files.filter(f => !f.type.startsWith('image/'));
  const distribution = { processing: 0, success: 0, error: 0, pending: 0 };
  
  docs.forEach(doc => {
    const key = buildAttachmentKey(doc.name, doc.size, doc.type);
    const status = docParseStatuses[key]?.status;
    if (status === 'processing') distribution.processing++;
    else if (status === 'success') distribution.success++;
    else if (status === 'error') distribution.error++;
    else distribution.pending++;
  });
  
  return distribution;
}

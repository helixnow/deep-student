import { invoke } from '@tauri-apps/api/core';

/** 加载失败哨兵：渲染为错误占位；题目切换回来时会重试（不当作已缓存） */
export const QUESTION_IMAGE_LOAD_ERROR = 'error';

interface QuestionImageRef {
  id: string;
  mime: string;
}

interface AttachmentContentResult {
  content: string | null;
  found: boolean;
}

type FetchAttachmentContent = (attachmentId: string) => Promise<AttachmentContentResult>;

const fetchViaVfs: FetchAttachmentContent = (attachmentId) =>
  invoke<AttachmentContentResult>('vfs_get_attachment_content', { attachmentId });

/**
 * 按题目 images_json 批量取图，返回 id → data URL / 失败哨兵。
 *
 * 每张图都会得到结果：取不到（found=false）或调用被拒绝（如 ID 无法解析）
 * 一律记为 QUESTION_IMAGE_LOAD_ERROR，避免占位永远停在加载动画（#465）。
 */
export async function loadQuestionImageUrls(
  images: readonly QuestionImageRef[],
  fetchContent: FetchAttachmentContent = fetchViaVfs,
): Promise<Record<string, string>> {
  const results = await Promise.allSettled(
    images.map(async (img) => {
      const result = await fetchContent(img.id);
      return result.found && result.content
        ? `data:${img.mime};base64,${result.content}`
        : QUESTION_IMAGE_LOAD_ERROR;
    }),
  );
  const urls: Record<string, string> = {};
  results.forEach((result, index) => {
    urls[images[index].id] = result.status === 'fulfilled' ? result.value : QUESTION_IMAGE_LOAD_ERROR;
  });
  return urls;
}

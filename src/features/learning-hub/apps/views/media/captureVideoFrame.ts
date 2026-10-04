/**
 * 截取 <video> 当前帧为 PNG（「截取当前帧 → 引用到聊天」）
 *
 * filestream 源需 `<video crossOrigin="anonymous">`（协议 CORS 白名单含应用源），
 * 否则 canvas 被污染，toBlob 抛 SecurityError —— 以 'tainted' 区分给出明确提示。
 */

/** 长边上限：控制上传体积（课件截图 1920 足够清晰） */
export const FRAME_MAX_EDGE = 1920;

export type CaptureFrameErrorCode = 'not_ready' | 'tainted' | 'failed';

export class CaptureFrameError extends Error {
  constructor(public readonly code: CaptureFrameErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'CaptureFrameError';
  }
}

export function fitFrameSize(width: number, height: number, maxEdge = FRAME_MAX_EDGE) {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export async function captureVideoFrame(video: HTMLVideoElement): Promise<Blob> {
  // HAVE_CURRENT_DATA = 2
  if (!video.videoWidth || !video.videoHeight || video.readyState < 2) {
    throw new CaptureFrameError('not_ready');
  }
  const { width, height } = fitFrameSize(video.videoWidth, video.videoHeight);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new CaptureFrameError('failed');
  ctx.drawImage(video, 0, 0, width, height);
  return new Promise<Blob>((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new CaptureFrameError('failed'));
      }, 'image/png');
    } catch (err: unknown) {
      reject(
        new CaptureFrameError(
          (err as DOMException | null)?.name === 'SecurityError' ? 'tainted' : 'failed',
        ),
      );
    }
  });
}

/** 文件名安全的时间标签：`12-34` / `1-02-03` */
export function frameFileName(mediaFileName: string, timestamp: string): string {
  const base = mediaFileName.replace(/\.[^.]+$/, '') || 'frame';
  return `${base}-${timestamp.replace(/:/g, '-')}.png`;
}

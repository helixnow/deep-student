/**
 * 格式化工具函数集合
 *
 * 提供常用的格式化功能，包括时间格式化、模型名称提取等
 */

/**
 * 从 modelId 提取具体的模型名称
 * 例如："Qwen/Qwen3-8B" -> "Qwen3-8B"
 *
 * @param modelId - 完整的模型ID
 * @returns 提取后的模型显示名称
 */
export function getModelDisplayName(modelId: string | undefined): string {
  if (!modelId) return '';
  const parts = modelId.split('/');
  return parts[parts.length - 1] || modelId;
}

/**
 * 格式化消息时间戳
 *
 * @param timestamp - 时间戳（毫秒）
 * @returns 格式化后的时间字符串（如 "14:35" 或 "12/05 14:35"）
 */
export function formatMessageTime(timestamp: number | undefined): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');

  if (isToday) {
    // 今天的消息只显示时间
    return `${hours}:${minutes}`;
  } else {
    // 非今天的消息显示日期和时间
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    return `${month}/${day} ${hours}:${minutes}`;
  }
}

/**
 * 格式化秒数为 MM:SS 格式（用于计时器显示）
 *
 * @param seconds - 总秒数
 * @returns 格式化后的时间字符串（如 "02:35"）
 */
export function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

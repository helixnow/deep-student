import { v4 as uuidv4 } from 'uuid';

// 统一：会话ID生成工具

export function generateSessionId(): string {
  return uuidv4();
}

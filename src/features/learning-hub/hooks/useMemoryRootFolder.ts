/**
 * 读取记忆根文件夹（ID + 标题），供记忆系统文件夹显示名本地化判定归属。
 *
 * 模块级缓存上次结果作为初值，避免各渲染点挂载时闪回存储名；每次挂载
 * （或 refreshKey 变化）后台刷新一次，覆盖用户在设置里改根目录的情况。
 * 读取失败（非 Tauri 环境 / 记忆未配置）时保留 null，调用方按默认标题回退。
 */
import { useEffect, useState } from 'react';
import { getMemoryConfig } from '@/api/memoryApi';
import type { MemoryRootRef } from '../memoryFolderLabels';

let lastKnownRoot: MemoryRootRef | null = null;

export function useMemoryRootFolder(refreshKey?: unknown): MemoryRootRef | null {
  const [root, setRoot] = useState<MemoryRootRef | null>(lastKnownRoot);
  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => getMemoryConfig())
      .then((config) => {
        const next: MemoryRootRef = {
          id: config?.memoryRootFolderId ?? null,
          title: config?.memoryRootFolderTitle ?? null,
        };
        lastKnownRoot = next;
        if (cancelled) return;
        setRoot((current) => (
          current?.id === next.id && current?.title === next.title ? current : next
        ));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);
  return root;
}

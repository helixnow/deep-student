import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getMemoryConfig, type MemoryConfig } from '@/api/memoryApi';
import { useFinderStore } from '../stores/finderStore';
import { MemoryGenerativeBriefing } from './MemoryGenerativeBriefing';

export interface MemoryFolderGenerativeBriefingProps {
  onRefresh?: () => void;
  onCreateMemory?: () => void;
}

/**
 * 记忆文件夹 Finder 视图 — 从 finderStore + memory config 构建简报。
 */
export const MemoryFolderGenerativeBriefing: React.FC<MemoryFolderGenerativeBriefingProps> = React.memo(
  ({ onRefresh, onCreateMemory }) => {
    const { t } = useTranslation(['learningHub']);
    const items = useFinderStore((s) => s.items);
    const breadcrumbs = useFinderStore((s) => s.currentPath.breadcrumbs);
    const [config, setConfig] = useState<MemoryConfig | null>(null);

    useEffect(() => {
      let cancelled = false;
      getMemoryConfig()
        .then((cfg) => {
          if (!cancelled) setConfig(cfg);
        })
        .catch(() => {
          if (!cancelled) setConfig(null);
        });
      return () => {
        cancelled = true;
      };
    }, []);

    const folderLabel = breadcrumbs?.[breadcrumbs.length - 1]?.name;
    const rootFolderTitle =
      folderLabel ?? config?.memoryRootFolderTitle ?? t('learningHub:memory.defaultRootTitle');

    const handleRefresh = useCallback(() => {
      onRefresh?.();
    }, [onRefresh]);

    const handleCreateMemory = useCallback(() => {
      onCreateMemory?.();
    }, [onCreateMemory]);

    const briefing = useMemo(
      () => (
        <MemoryGenerativeBriefing
          memoryCount={items.length}
          rootFolderTitle={rootFolderTitle}
          autoExtractFrequency={config?.autoExtractFrequency}
          recentItems={items.slice(0, 8).map((item) => ({
            label: item.name,
          }))}
          onRefresh={handleRefresh}
          onCreateMemory={handleCreateMemory}
        />
      ),
      [
        config?.autoExtractFrequency,
        handleCreateMemory,
        handleRefresh,
        items,
        rootFolderTitle,
      ],
    );

    return briefing;
  },
);

MemoryFolderGenerativeBriefing.displayName = 'MemoryFolderGenerativeBriefing';

export default MemoryFolderGenerativeBriefing;

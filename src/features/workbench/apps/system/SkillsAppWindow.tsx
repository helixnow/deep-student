/**
 * 技能管理应用窗口（P9 薄包装 → O18 窗口化打磨）
 *
 * `SkillsManagementPage` 自含桌面布局（左列表 + 右详情），零布局适配复用。
 * O18 打磨：lazy 化 + 列表形态骨架屏 + 内容淡入；窗口尺寸分级写到
 * data-wb-sys-size 并以 windowSizeClass 下传页面——非 wide 档工具栏
 * 次级操作收进溢出菜单（页面自身的 viewport 断点在窗口里恒为桌面，
 * 拿不到紧凑布局）。页面内滚动由 legacy 页面自含，窗口只做裁剪边界。
 */
import React, { Suspense, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppWindowProps } from '../../core/types';
import { WbSysFade, WbSysSkeleton } from './SystemWindowShared';
import { useWbSysSize } from './useWbSysSize';

const SkillsManagementPage = React.lazy(() =>
  import('@/features/skills-management').then((m) => ({
    default: m.SkillsManagementPage,
  })),
);

const SkillsAppWindow: React.FC<AppWindowProps> = ({ windowId, onTitleChange }) => {
  const { t } = useTranslation('workbench');
  const { ref, sizeClass } = useWbSysSize();

  useEffect(() => {
    onTitleChange(t('workbench:apps.skills'));
  }, [onTitleChange, t]);

  return (
    <div
      ref={ref}
      className="relative h-full w-full min-w-0 overflow-hidden bg-background"
      data-wb-sys-app="skills"
    >
      <Suspense fallback={<WbSysSkeleton variant="list" />}>
        <WbSysFade>
          <SkillsManagementPage
            className="h-full"
            workbenchWindowId={windowId}
            windowSizeClass={sizeClass}
          />
        </WbSysFade>
      </Suspense>
    </div>
  );
};

export default SkillsAppWindow;

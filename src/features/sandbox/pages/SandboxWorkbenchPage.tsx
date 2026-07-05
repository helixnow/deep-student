import React from 'react';
import { useTranslation } from 'react-i18next';

import { useMobileHeader } from '@/components/layout';
import { SandboxWorkbenchSurface } from '../components/SandboxWorkbenchSurface';

export function SandboxWorkbenchPage() {
  const { t } = useTranslation('common');

  // D-1: 移动端顶栏标题（sandbox-workbench 独立视图形态；
  // 作为 chat-v2 右屏嵌入时不经过本页面组件，不受影响）
  useMobileHeader('sandbox-workbench', {
    title: t('navigation.sandbox_workbench', '沙箱工作台'),
  }, [t]);

  return <SandboxWorkbenchSurface className="h-full" />;
}

export default SandboxWorkbenchPage;

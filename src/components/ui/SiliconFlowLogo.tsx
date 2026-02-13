/**
 * SiliconFlow Logo 组件
 * 自动根据主题切换明暗版本的 logo
 */

import React from 'react';
import { cn } from '../../lib/utils';
import siliconFlowLogoLight from '../../assets/siliconflowlogo.svg';
import siliconFlowLogoDark from '../../assets/siliconflowlogo-dark.svg';

interface SiliconFlowLogoProps {
  className?: string;
  alt?: string;
}

export const SiliconFlowLogo: React.FC<SiliconFlowLogoProps> = ({
  className,
  alt = 'SiliconFlow'
}) => {
  return (
    <>
      {/* 亮色模式下显示的 logo */}
      <img
        src={siliconFlowLogoLight}
        alt={alt}
        className={cn('dark:hidden', className)}
      />
      {/* 暗色模式下显示的 logo */}
      <img
        src={siliconFlowLogoDark}
        alt={alt}
        className={cn('hidden dark:block', className)}
      />
    </>
  );
};

export default SiliconFlowLogo;

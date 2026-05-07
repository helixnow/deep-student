import React from 'react';
import SiliconCloudColor from '@lobehub/icons/es/SiliconCloud/components/Color';
import { cn } from '../../lib/utils';

interface SiliconFlowLogoProps {
  className?: string;
  alt?: string;
}

export const SiliconFlowLogo: React.FC<SiliconFlowLogoProps> = ({
  className,
  alt = 'SiliconFlow',
}) => {
  return (
    <span
      className={cn('inline-flex aspect-square shrink-0 items-center justify-center', className)}
      role="img"
      aria-label={alt}
    >
      <SiliconCloudColor size="100%" aria-hidden="true" />
    </span>
  );
};

export default SiliconFlowLogo;

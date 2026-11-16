import * as React from 'react';
import { Badge } from '@/components/ui/shad/Badge';

/** 小标签（`@deepstudent/ui` 公共 API），用于分类、状态等短文字。 */
export type DsBadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline';

export interface DsBadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 默认 `secondary`（灰色）；`default` 是主题色。 */
  variant?: DsBadgeVariant;
}

export const DsBadge = React.forwardRef<HTMLDivElement, DsBadgeProps>(({ variant = 'secondary', ...props }, ref) => (
  <Badge ref={ref} variant={variant} {...props} />
));
DsBadge.displayName = 'DsBadge';

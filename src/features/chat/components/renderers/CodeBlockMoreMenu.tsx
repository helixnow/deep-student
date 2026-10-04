import React from 'react';
import { DotsThree } from '@phosphor-icons/react';

import { DsButton } from '@/components/ui/DsButton';
import {
  AppMenu,
  AppMenuContent,
  AppMenuGroup,
  AppMenuItem,
  AppMenuTrigger,
} from '@/components/ui/app-menu/AppMenu';

export interface CodeBlockMenuAction {
  key: string;
  label: string;
  icon: React.ReactNode;
  onSelect: () => void;
  disabled?: boolean;
}

interface CodeBlockMoreMenuProps {
  actions: CodeBlockMenuAction[];
  label: string;
}

/** 可预览代码块（SVG / HTML）头部的「…」更多菜单 */
export const CodeBlockMoreMenu: React.FC<CodeBlockMoreMenuProps> = ({ actions, label }) => (
  <AppMenu>
    <AppMenuTrigger asChild>
      <DsButton
        variant="ghost"
        size="icon"
        iconOnly
        className="code-block-copy code-block-more-trigger"
        aria-label={label}
        title={label}
      >
        <DotsThree size={16} weight="bold" />
      </DsButton>
    </AppMenuTrigger>
    <AppMenuContent align="end" width={184} aria-label={label}>
      <AppMenuGroup>
        {actions.map((action) => (
          <AppMenuItem
            key={action.key}
            icon={action.icon}
            disabled={action.disabled}
            data-action={action.key}
            onClick={action.onSelect}
          >
            {action.label}
          </AppMenuItem>
        ))}
      </AppMenuGroup>
    </AppMenuContent>
  </AppMenu>
);

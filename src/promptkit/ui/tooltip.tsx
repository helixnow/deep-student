import React from 'react';

export const TooltipProvider: React.FC<{ children: React.ReactNode }>
  = ({ children }) => <>{children}</>;

export const Tooltip: React.FC<{ children: React.ReactNode } & React.HTMLAttributes<HTMLDivElement>>
  = ({ children }) => <>{children}</>;

export const TooltipTrigger: React.FC<{ children: React.ReactNode } & React.HTMLAttributes<HTMLElement>>
  = ({ children, ...props }) => <span {...props}>{children}</span>;

export const TooltipContent: React.FC<{ children: React.ReactNode } & React.HTMLAttributes<HTMLDivElement>>
  = ({ children }) => <>{children}</>;


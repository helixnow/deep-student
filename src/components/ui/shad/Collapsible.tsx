/**
 * Collapsible 组件
 * 简单实现，不依赖 Radix UI
 */

import * as React from 'react';

interface CollapsibleProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
}

const CollapsibleContext = React.createContext<{
  open: boolean;
  setOpen: (open: boolean) => void;
}>({ open: false, setOpen: () => {} });

const Collapsible: React.FC<CollapsibleProps> = ({ 
  open: controlledOpen, 
  onOpenChange, 
  children, 
  className 
}) => {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  
  const setOpen = React.useCallback((value: boolean) => {
    if (!isControlled) {
      setInternalOpen(value);
    }
    onOpenChange?.(value);
  }, [isControlled, onOpenChange]);

  return (
    <CollapsibleContext.Provider value={{ open, setOpen }}>
      <div className={className} data-state={open ? 'open' : 'closed'}>
        {children}
      </div>
    </CollapsibleContext.Provider>
  );
};

const CollapsibleTrigger: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({ 
  children, 
  onClick, 
  ...props 
}) => {
  const { open, setOpen } = React.useContext(CollapsibleContext);
  
  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    setOpen(!open);
    onClick?.(e);
  };

  return (
    <button type="button" onClick={handleClick} data-state={open ? 'open' : 'closed'} {...props}>
      {children}
    </button>
  );
};

const CollapsibleContent: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ 
  children, 
  className,
  ...props 
}) => {
  const { open } = React.useContext(CollapsibleContext);

  if (!open) return null;

  return (
    <div className={className} data-state={open ? 'open' : 'closed'} {...props}>
      {children}
    </div>
  );
};

export { Collapsible, CollapsibleTrigger, CollapsibleContent };


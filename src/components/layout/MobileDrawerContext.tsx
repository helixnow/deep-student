import React, { createContext, useContext } from 'react';

const MobileUnifiedDrawerContext = createContext(false);

export const MobileUnifiedDrawerProvider: React.FC<{
  value?: boolean;
  children: React.ReactNode;
}> = ({ value = true, children }) => (
  <MobileUnifiedDrawerContext.Provider value={value}>
    {children}
  </MobileUnifiedDrawerContext.Provider>
);

/** 页内 sidebar 是否嵌在 MobileSlidingLayout 的统一滚动抽屉中 */
export function useMobileUnifiedDrawer(): boolean {
  return useContext(MobileUnifiedDrawerContext);
}

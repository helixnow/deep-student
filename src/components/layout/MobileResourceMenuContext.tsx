import { createContext, useContext } from 'react';

interface MobileResourceMenuHost {
  element: HTMLDivElement | null;
  close: () => void;
}

// A missing provider keeps standalone editors' own page actions available.
export const MobileResourceMenuContext = createContext<MobileResourceMenuHost | undefined>(undefined);

export const useMobileResourceMenu = () => useContext(MobileResourceMenuContext);

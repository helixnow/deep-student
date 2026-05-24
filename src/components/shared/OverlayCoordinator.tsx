import React from 'react';

export interface OverlayCoordinatorValue {
  activeInteractiveOverlayCount: number;
  tooltipsSuppressed: boolean;
  tooltipDismissVersion: number;
  dismissTooltips: () => void;
  registerInteractiveOverlay: () => () => void;
}

const fallbackOverlayCoordinator: OverlayCoordinatorValue = {
  activeInteractiveOverlayCount: 0,
  tooltipsSuppressed: false,
  tooltipDismissVersion: 0,
  dismissTooltips: () => {},
  registerInteractiveOverlay: () => () => {},
};

const OverlayCoordinatorContext = React.createContext<OverlayCoordinatorValue>(fallbackOverlayCoordinator);

export function OverlayCoordinatorProvider({ children }: { children: React.ReactNode }) {
  const [activeInteractiveOverlayCount, setActiveInteractiveOverlayCount] = React.useState(0);
  const [tooltipDismissVersion, setTooltipDismissVersion] = React.useState(0);

  const dismissTooltips = React.useCallback(() => {
    setTooltipDismissVersion((version) => version + 1);
  }, []);

  const registerInteractiveOverlay = React.useCallback(() => {
    let released = false;

    setActiveInteractiveOverlayCount((count) => count + 1);
    setTooltipDismissVersion((version) => version + 1);

    return () => {
      if (released) return;
      released = true;
      setActiveInteractiveOverlayCount((count) => Math.max(0, count - 1));
    };
  }, []);

  const value = React.useMemo<OverlayCoordinatorValue>(() => ({
    activeInteractiveOverlayCount,
    tooltipsSuppressed: activeInteractiveOverlayCount > 0,
    tooltipDismissVersion,
    dismissTooltips,
    registerInteractiveOverlay,
  }), [activeInteractiveOverlayCount, dismissTooltips, registerInteractiveOverlay, tooltipDismissVersion]);

  return (
    <OverlayCoordinatorContext.Provider value={value}>
      {children}
    </OverlayCoordinatorContext.Provider>
  );
}

export function useOverlayCoordinator(): OverlayCoordinatorValue {
  return React.useContext(OverlayCoordinatorContext);
}

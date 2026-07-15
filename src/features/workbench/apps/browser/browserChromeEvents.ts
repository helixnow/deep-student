/** Browser chrome ↔ register 共享事件名（避免 register ↔ window 循环依赖） */
export const BROWSER_FOCUS_ADDRESS_EVENT = 'workbench:browser:focus-address';

export interface BrowserFocusAddressEventDetail {
  windowId: string;
  acknowledge: (focused: boolean) => void;
}

/** Kernel-issued, single-call capability. Not exported through the plugin SDK or Context. */
// RUST-FIX(RF-P3-workshop-tools): UI authority is issued by transport-bound kernel dispatch, never payload data.
import type { WindowRef } from './api.ts';
interface ReceiptBinding { service: string; method: string; signal: AbortSignal }
const receipts = new WeakMap<object, ReceiptBinding>();
export function workshopUiReceipt(source: WindowRef, caller: string | undefined, service: string, method: string, signal: AbortSignal): object {
  if (caller !== 'dstu.plugin-workshop' || source.window !== 'main' || source.webview !== 'main' || source.origin !== undefined) {
    throw new Error('WORKSHOP_UI_REQUIRED: only the paired workshop UI in the local main window may act');
  }
  const receipt = Object.freeze({ signal });
  receipts.set(receipt, { service, method, signal });
  return receipt;
}
export function consumeWorkshopUiReceipt(receipt: unknown, service: string, method: string): Readonly<{ signal: AbortSignal }> {
  const binding = typeof receipt === 'object' && receipt !== null ? receipts.get(receipt) : undefined;
  if (!binding || binding.service !== service || binding.method !== method) {
    throw new Error('WORKSHOP_UI_REQUIRED: Host plugin calls cannot authorize workshop user actions');
  }
  receipts.delete(receipt as object);
  return Object.freeze({ signal: binding.signal });
}
export function releaseWorkshopUiReceipt(receipt: object): void { receipts.delete(receipt); }

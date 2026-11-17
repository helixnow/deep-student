/** Community views participate in the existing read-only Workbench observation runtime. */
import type { UiKernel } from '@/ui-kernel/kernel';
import type { AgentAffordanceNode, AgentAppContext, AgentJsonValue, AgentObservationPatch, AppAgentManifest } from '../../core/types';
import { stableAgentRef, stableRevision } from '../agentManifestUtils';

const CONTROLS = 'button,a[href],input,textarea,select,[role="button"],[role="checkbox"],[role="switch"],[contenteditable="true"]';
type Control = { ref: string; kind: string; label: string; actions: string[]; disabled: boolean; value?: string | boolean; options?: { value: string; label: string }[] };

function visible(element: HTMLElement, root: HTMLElement): boolean {
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.hidden || current.getAttribute('aria-hidden') === 'true') return false;
    const style = getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (current === root) break;
  }
  return true;
}

function labelOf(element: HTMLElement): string {
  const labelledBy = element.getAttribute('aria-labelledby')?.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ').trim();
  const labels = 'labels' in element ? Array.from((element as HTMLInputElement).labels ?? []).map(label => label.textContent ?? '').join(' ').trim() : '';
  return element.getAttribute('aria-label') || labelledBy || labels || element.getAttribute('placeholder') || element.textContent?.trim() || element.getAttribute('title') || element.getAttribute('name') || element.tagName.toLowerCase();
}

function controlInfo(element: HTMLElement, ref: string): Control | null {
  const disabled = ('disabled' in element && Boolean((element as HTMLButtonElement).disabled)) || element.getAttribute('aria-disabled') === 'true';
  const info: Control = { ref, kind: 'plugin-control', label: labelOf(element), actions: [], disabled };
  if (element instanceof HTMLInputElement) {
    if (['hidden', 'file'].includes(element.type)) return null;
    if (['checkbox', 'radio'].includes(element.type)) { info.value = element.checked; }
    else if (!['password', 'button', 'submit', 'reset', 'image'].includes(element.type)) info.value = element.value;
  } else if (element instanceof HTMLTextAreaElement) {
    info.value = element.value;
  } else if (element instanceof HTMLSelectElement) {
    info.value = element.value;
    info.options = Array.from(element.options).filter(option => !option.disabled).map(option => ({ value: option.value, label: option.label }));
  } else if (element.getAttribute('contenteditable') === 'true') {
    info.value = element.innerText ?? element.textContent ?? '';
  }
  return info;
}

/** DOM access is limited to this plugin's rendered view inside the runtime-selected window. */
export function createPluginViewAgentManifest(pluginId: string, viewId: string, kernel: UiKernel): AppAgentManifest {
  const ids = new WeakMap<HTMLElement, string>();
  let nextId = 0;
  const refOf = (element: HTMLElement, windowId: string): string => {
    let id = ids.get(element);
    if (!id) { id = String(++nextId); ids.set(element, id); }
    return stableAgentRef(pluginId, viewId, windowId, id);
  };
  const observe = (ctx: AgentAppContext): AgentObservationPatch => {
    const window = Array.from(document.querySelectorAll<HTMLElement>('[data-wb-window]'))
      .find(element => element.getAttribute('data-window-id') === ctx.windowId);
    const root = window && Array.from(window.querySelectorAll<HTMLElement>('[data-testid="wb-plugin-view-window"]'))
      .find(element => element.dataset.pluginOwner === pluginId && element.dataset.pluginView === viewId);
    const plugin = kernel.plugins().find(item => item.id === pluginId);
    // Read the mounted version, so an uncommitted React update cannot certify an old page as the new candidate.
    const version = root?.dataset.pluginVersion || null;
    const loadedVersion = plugin?.meta.version ?? null;
    const viewExists = kernel.slots.list('views').some(entry => entry.owner === pluginId && entry.key === viewId);
    const status = !window || !viewExists ? 'missing'
      : root?.querySelector('[data-testid="wb-plugin-view-failed"]') ? 'failed'
        : !root || version !== loadedVersion || root.querySelector('[data-testid="wb-plugin-view-loading"]') ? 'loading' : 'ready';
    const controls: Control[] = [];
    if (root && status === 'ready') for (const element of root.querySelectorAll<HTMLElement>(CONTROLS)) {
      if (!visible(element, root)) continue;
      const info = controlInfo(element, refOf(element, ctx.windowId));
      if (!info) continue;
      // Workshop verification is read-only; control values do not grant interaction authority.
      controls.push(info);
    }
    const text = root ? root.innerText ?? root.textContent ?? '' : '';
    const errors = kernel.errors.list(pluginId).filter(report => (report.version ?? null) === version).map(report => report.message);
    const state = { pluginId, viewId, version, status, text, errors, controls };
    const affordances: AgentAffordanceNode[] = controls.map(({ options: _options, ...control }) => control);
    return {
      revision: stableRevision(state), route: `plugin/${pluginId}/${viewId}`, mode: 'plugin-view', busy: status === 'loading',
      state: state as unknown as Record<string, AgentJsonValue>,
      availableActions: [],
      affordances, entities: controls.map(({ disabled: _disabled, value, options, ...control }) => ({ ...control, state: {
        ...(value === undefined ? {} : { value }), ...(options ? { options } : {}),
      } })),
    };
  };
  return {
    version: 1,
    description: '只读观察已挂载的插件页面、版本、真实文本与控件。ready 只表示页面已挂载，功能是否符合目标须检查实际结果。',
    capabilities: [],
    observe,
  };
}

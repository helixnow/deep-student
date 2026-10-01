import { afterEach, describe, expect, it, vi } from 'vitest';
import { debugMasterSwitch } from '../../debugMasterSwitch';
import { emitToolCallDebug, trackPreparing, trackEnd, TOOLCALL_LIFECYCLE_EVENT } from '../ToolCallLifecycleDebugPlugin';

afterEach(() => {
  debugMasterSwitch.disable();
  vi.restoreAllMocks();
});

describe('tool lifecycle diagnostic switch', () => {
  it('does not build detail while disabled and releases collector resources when disabled', () => {
    debugMasterSwitch.disable();
    const details = vi.fn(() => ({ detail: { largeInput: 'x'.repeat(100_000) } }));
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const interval = vi.spyOn(globalThis, 'setInterval');
    const clear = vi.spyOn(globalThis, 'clearInterval');
    emitToolCallDebug('info', 'backend:start', 'disabled', details);
    trackPreparing('disabled', 'tool');
    trackEnd('disabled', true);
    expect(details).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
    debugMasterSwitch.enable();
    expect(add).toHaveBeenCalledWith(TOOLCALL_LIFECYCLE_EVENT, expect.any(Function));
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 5000);
    emitToolCallDebug('info', 'backend:start', 'enabled', details);
    expect(details).toHaveBeenCalledTimes(1);
    debugMasterSwitch.disable();
    expect(remove).toHaveBeenCalledWith(TOOLCALL_LIFECYCLE_EVENT, expect.any(Function));
    expect(clear).toHaveBeenCalled();
    emitToolCallDebug('info', 'backend:start', 'disabled again', details);
    expect(details).toHaveBeenCalledTimes(1);
  });
});

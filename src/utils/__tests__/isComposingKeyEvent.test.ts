import { describe, expect, it } from 'vitest';
import { isComposingKeyEvent } from '../isComposingKeyEvent';

describe('isComposingKeyEvent', () => {
  it.each([
    { isComposing: true },
    { keyCode: 229 },
    { nativeEvent: { isComposing: true } },
    { nativeEvent: { isComposing: false, keyCode: 229 } },
  ])('recognizes composition for native and React event shapes (%j)', (event) => {
    expect(isComposingKeyEvent(event)).toBe(true);
  });

  it('allows normal keys after composition ends', () => {
    expect(isComposingKeyEvent({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isComposingKeyEvent({ nativeEvent: { isComposing: false, keyCode: 27 } })).toBe(false);
  });
});

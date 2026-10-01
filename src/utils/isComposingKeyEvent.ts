interface CompositionKeyEvent {
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: {
    isComposing?: boolean;
    keyCode?: number;
  };
}

/** Native and React keyboard events; keyCode 229 covers IME confirmation in WebKit. */
export function isComposingKeyEvent(event: CompositionKeyEvent): boolean {
  return event.isComposing === true
    || event.keyCode === 229
    || event.nativeEvent?.isComposing === true
    || event.nativeEvent?.keyCode === 229;
}

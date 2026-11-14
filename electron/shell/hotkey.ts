/**
 * global-hotkey 0.8.0（`src/hotkey.rs` `parse_hotkey` / `parse_key` / `HotKey::new` / `into_string`）的移植，
 * 用于 tauri-plugin-global-shortcut 的快捷键解析、id（`mods.bits() << 16 | key as u32`）与规范化字符串。
 * `CODE_NAMES` 为 keyboard-types 0.7.0 `Code` 枚举的声明顺序（判别值 = 下标），由源码生成。
 */
import type { ShellPlatform } from './tauri-config.ts';

export const CODE_NAMES: readonly string[] = ["Backquote", "Backslash", "BracketLeft", "BracketRight", "Comma", "Digit0", "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9", "Equal", "IntlBackslash", "IntlRo", "IntlYen", "KeyA", "KeyB", "KeyC", "KeyD", "KeyE", "KeyF", "KeyG", "KeyH", "KeyI", "KeyJ", "KeyK", "KeyL", "KeyM", "KeyN", "KeyO", "KeyP", "KeyQ", "KeyR", "KeyS", "KeyT", "KeyU", "KeyV", "KeyW", "KeyX", "KeyY", "KeyZ", "Minus", "Period", "Quote", "Semicolon", "Slash", "AltLeft", "AltRight", "Backspace", "CapsLock", "ContextMenu", "ControlLeft", "ControlRight", "Enter", "MetaLeft", "MetaRight", "ShiftLeft", "ShiftRight", "Space", "Tab", "Convert", "KanaMode", "Lang1", "Lang2", "Lang3", "Lang4", "Lang5", "NonConvert", "Delete", "End", "Help", "Home", "Insert", "PageDown", "PageUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "NumLock", "Numpad0", "Numpad1", "Numpad2", "Numpad3", "Numpad4", "Numpad5", "Numpad6", "Numpad7", "Numpad8", "Numpad9", "NumpadAdd", "NumpadBackspace", "NumpadClear", "NumpadClearEntry", "NumpadComma", "NumpadDecimal", "NumpadDivide", "NumpadEnter", "NumpadEqual", "NumpadHash", "NumpadMemoryAdd", "NumpadMemoryClear", "NumpadMemoryRecall", "NumpadMemoryStore", "NumpadMemorySubtract", "NumpadMultiply", "NumpadParenLeft", "NumpadParenRight", "NumpadStar", "NumpadSubtract", "Escape", "Fn", "FnLock", "PrintScreen", "ScrollLock", "Pause", "BrowserBack", "BrowserFavorites", "BrowserForward", "BrowserHome", "BrowserRefresh", "BrowserSearch", "BrowserStop", "Eject", "LaunchApp1", "LaunchApp2", "LaunchMail", "MediaPlayPause", "MediaSelect", "MediaStop", "MediaTrackNext", "MediaTrackPrevious", "Power", "Sleep", "AudioVolumeDown", "AudioVolumeMute", "AudioVolumeUp", "WakeUp", "Hyper", "Super", "Turbo", "Abort", "Resume", "Suspend", "Again", "Copy", "Cut", "Find", "Open", "Paste", "Props", "Select", "Undo", "Hiragana", "Katakana", "Unidentified", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12", "F13", "F14", "F15", "F16", "F17", "F18", "F19", "F20", "F21", "F22", "F23", "F24", "F25", "F26", "F27", "F28", "F29", "F30", "F31", "F32", "F33", "F34", "F35", "BrightnessDown", "BrightnessUp", "DisplayToggleIntExt", "KeyboardLayoutSelect", "LaunchAssistant", "LaunchControlPanel", "LaunchScreenSaver", "MailForward", "MailReply", "MailSend", "MediaFastForward", "MediaPause", "MediaPlay", "MediaRecord", "MediaRewind", "MicrophoneMuteToggle", "PrivacyScreenToggle", "SelectTask", "ShowAllWindows", "ZoomToggle"];

const KEY_TABLE: Readonly<Record<string, string>> = {"BACKQUOTE": "Backquote", "`": "Backquote", "BACKSLASH": "Backslash", "\\": "Backslash", "BRACKETLEFT": "BracketLeft", "[": "BracketLeft", "BRACKETRIGHT": "BracketRight", "]": "BracketRight", "PAUSE": "Pause", "PAUSEBREAK": "Pause", "COMMA": "Comma", ",": "Comma", "DIGIT0": "Digit0", "0": "Digit0", "DIGIT1": "Digit1", "1": "Digit1", "DIGIT2": "Digit2", "2": "Digit2", "DIGIT3": "Digit3", "3": "Digit3", "DIGIT4": "Digit4", "4": "Digit4", "DIGIT5": "Digit5", "5": "Digit5", "DIGIT6": "Digit6", "6": "Digit6", "DIGIT7": "Digit7", "7": "Digit7", "DIGIT8": "Digit8", "8": "Digit8", "DIGIT9": "Digit9", "9": "Digit9", "EQUAL": "Equal", "=": "Equal", "KEYA": "KeyA", "A": "KeyA", "KEYB": "KeyB", "B": "KeyB", "KEYC": "KeyC", "C": "KeyC", "KEYD": "KeyD", "D": "KeyD", "KEYE": "KeyE", "E": "KeyE", "KEYF": "KeyF", "F": "KeyF", "KEYG": "KeyG", "G": "KeyG", "KEYH": "KeyH", "H": "KeyH", "KEYI": "KeyI", "I": "KeyI", "KEYJ": "KeyJ", "J": "KeyJ", "KEYK": "KeyK", "K": "KeyK", "KEYL": "KeyL", "L": "KeyL", "KEYM": "KeyM", "M": "KeyM", "KEYN": "KeyN", "N": "KeyN", "KEYO": "KeyO", "O": "KeyO", "KEYP": "KeyP", "P": "KeyP", "KEYQ": "KeyQ", "Q": "KeyQ", "KEYR": "KeyR", "R": "KeyR", "KEYS": "KeyS", "S": "KeyS", "KEYT": "KeyT", "T": "KeyT", "KEYU": "KeyU", "U": "KeyU", "KEYV": "KeyV", "V": "KeyV", "KEYW": "KeyW", "W": "KeyW", "KEYX": "KeyX", "X": "KeyX", "KEYY": "KeyY", "Y": "KeyY", "KEYZ": "KeyZ", "Z": "KeyZ", "MINUS": "Minus", "-": "Minus", "PERIOD": "Period", ".": "Period", "QUOTE": "Quote", "'": "Quote", "SEMICOLON": "Semicolon", ";": "Semicolon", "SLASH": "Slash", "/": "Slash", "BACKSPACE": "Backspace", "CAPSLOCK": "CapsLock", "ENTER": "Enter", "SPACE": "Space", "TAB": "Tab", "DELETE": "Delete", "END": "End", "HOME": "Home", "INSERT": "Insert", "PAGEDOWN": "PageDown", "PAGEUP": "PageUp", "PRINTSCREEN": "PrintScreen", "SCROLLLOCK": "ScrollLock", "ARROWDOWN": "ArrowDown", "DOWN": "ArrowDown", "ARROWLEFT": "ArrowLeft", "LEFT": "ArrowLeft", "ARROWRIGHT": "ArrowRight", "RIGHT": "ArrowRight", "ARROWUP": "ArrowUp", "UP": "ArrowUp", "NUMLOCK": "NumLock", "NUMPAD0": "Numpad0", "NUM0": "Numpad0", "NUMPAD1": "Numpad1", "NUM1": "Numpad1", "NUMPAD2": "Numpad2", "NUM2": "Numpad2", "NUMPAD3": "Numpad3", "NUM3": "Numpad3", "NUMPAD4": "Numpad4", "NUM4": "Numpad4", "NUMPAD5": "Numpad5", "NUM5": "Numpad5", "NUMPAD6": "Numpad6", "NUM6": "Numpad6", "NUMPAD7": "Numpad7", "NUM7": "Numpad7", "NUMPAD8": "Numpad8", "NUM8": "Numpad8", "NUMPAD9": "Numpad9", "NUM9": "Numpad9", "NUMPADADD": "NumpadAdd", "NUMADD": "NumpadAdd", "NUMPADPLUS": "NumpadAdd", "NUMPLUS": "NumpadAdd", "NUMPADDECIMAL": "NumpadDecimal", "NUMDECIMAL": "NumpadDecimal", "NUMPADDIVIDE": "NumpadDivide", "NUMDIVIDE": "NumpadDivide", "NUMPADENTER": "NumpadEnter", "NUMENTER": "NumpadEnter", "NUMPADEQUAL": "NumpadEqual", "NUMEQUAL": "NumpadEqual", "NUMPADMULTIPLY": "NumpadMultiply", "NUMMULTIPLY": "NumpadMultiply", "NUMPADSUBTRACT": "NumpadSubtract", "NUMSUBTRACT": "NumpadSubtract", "ESCAPE": "Escape", "ESC": "Escape", "F1": "F1", "F2": "F2", "F3": "F3", "F4": "F4", "F5": "F5", "F6": "F6", "F7": "F7", "F8": "F8", "F9": "F9", "F10": "F10", "F11": "F11", "F12": "F12", "AUDIOVOLUMEDOWN": "AudioVolumeDown", "VOLUMEDOWN": "AudioVolumeDown", "AUDIOVOLUMEUP": "AudioVolumeUp", "VOLUMEUP": "AudioVolumeUp", "AUDIOVOLUMEMUTE": "AudioVolumeMute", "VOLUMEMUTE": "AudioVolumeMute", "MEDIAPLAY": "MediaPlay", "MEDIAPAUSE": "MediaPause", "MEDIAPLAYPAUSE": "MediaPlayPause", "MEDIASTOP": "MediaStop", "MEDIATRACKNEXT": "MediaTrackNext", "MEDIATRACKPREV": "MediaTrackPrevious", "MEDIATRACKPREVIOUS": "MediaTrackPrevious", "F13": "F13", "F14": "F14", "F15": "F15", "F16": "F16", "F17": "F17", "F18": "F18", "F19": "F19", "F20": "F20", "F21": "F21", "F22": "F22", "F23": "F23", "F24": "F24"};

/** keyboard-types `Modifiers` 位。 */
export const MOD_ALT = 0x01;
export const MOD_CONTROL = 0x08;
export const MOD_SHIFT = 0x200;
export const MOD_SUPER = 0x2000;

export interface ParsedHotKey {
  mods: number;
  key: string;
  id: number;
}

export class HotKeyParseError extends Error {}

function parseKey(key: string): string {
  const code = KEY_TABLE[key.toUpperCase()];
  if (code === undefined) {
    throw new HotKeyParseError(`Couldn't recognize "${key}" as a valid key for hotkey, if you feel like it should be, please report this to https://github.com/tauri-apps/muda`);
  }
  return code;
}

export function parseHotKey(hotkey: string, platform: ShellPlatform): ParsedHotKey {
  const tokens = hotkey.split('+');
  let mods = 0;
  let key: string | null = null;
  if (tokens.length === 1) {
    key = parseKey(tokens[0] as string);
  } else {
    for (const raw of tokens) {
      const token = raw.trim();
      if (token === '') throw new HotKeyParseError(`Found empty token while parsing hotkey: ${hotkey}`);
      if (key !== null) {
        throw new HotKeyParseError(`Invalid hotkey format: "${hotkey}", an hotkey should have the modifiers first and only one main key, for example: "Shift + Alt + K"`);
      }
      switch (token.toUpperCase()) {
        case 'OPTION':
        case 'ALT':
          mods |= MOD_ALT;
          break;
        case 'CONTROL':
        case 'CTRL':
          mods |= MOD_CONTROL;
          break;
        case 'COMMAND':
        case 'CMD':
        case 'SUPER':
          mods |= MOD_SUPER;
          break;
        case 'SHIFT':
          mods |= MOD_SHIFT;
          break;
        case 'COMMANDORCONTROL':
        case 'COMMANDORCTRL':
        case 'CMDORCTRL':
        case 'CMDORCONTROL':
          mods |= platform === 'darwin' ? MOD_SUPER : MOD_CONTROL;
          break;
        default:
          key = parseKey(token);
      }
    }
  }
  if (key === null) {
    throw new HotKeyParseError(`Invalid hotkey format: "${hotkey}", an hotkey should have the modifiers first and only one main key, for example: "Shift + Alt + K"`);
  }
  return { mods, key, id: ((mods << 16) | CODE_NAMES.indexOf(key)) >>> 0 };
}

/** `HotKey::into_string`。 */
export function hotKeyToString(hotkey: ParsedHotKey): string {
  let out = '';
  if (hotkey.mods & MOD_SHIFT) out += 'shift+';
  if (hotkey.mods & MOD_CONTROL) out += 'control+';
  if (hotkey.mods & MOD_ALT) out += 'alt+';
  if (hotkey.mods & MOD_SUPER) out += 'super+';
  return out + hotkey.key;
}

const ACCELERATOR_KEYS: Readonly<Record<string, string>> = {
  Backquote: '`', Backslash: '\\', BracketLeft: '[', BracketRight: ']', Comma: ',', Equal: '=', Minus: '-', Period: '.',
  Quote: "'", Semicolon: ';', Slash: '/', Backspace: 'Backspace', CapsLock: 'Capslock', Enter: 'Enter', Space: 'Space',
  Tab: 'Tab', Delete: 'Delete', End: 'End', Home: 'Home', Insert: 'Insert', PageDown: 'PageDown', PageUp: 'PageUp',
  PrintScreen: 'PrintScreen', ScrollLock: 'Scrolllock', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  ArrowUp: 'Up', NumLock: 'Numlock', NumpadAdd: 'numadd', NumpadDecimal: 'numdec', NumpadDivide: 'numdiv',
  NumpadEnter: 'Enter', NumpadMultiply: 'nummult', NumpadSubtract: 'numsub', Escape: 'Escape', Pause: 'Pause',
  AudioVolumeDown: 'VolumeDown', AudioVolumeUp: 'VolumeUp', AudioVolumeMute: 'VolumeMute', MediaPlayPause: 'MediaPlayPause',
  MediaStop: 'MediaStop', MediaTrackNext: 'MediaNextTrack', MediaTrackPrevious: 'MediaPreviousTrack',
};

/** 解析结果 → Electron Accelerator（同一快捷键在两边描述同一组物理按键）。 */
export function toElectronAccelerator(hotkey: ParsedHotKey): string | null {
  const parts: string[] = [];
  if (hotkey.mods & MOD_CONTROL) parts.push('Control');
  if (hotkey.mods & MOD_ALT) parts.push('Alt');
  if (hotkey.mods & MOD_SHIFT) parts.push('Shift');
  if (hotkey.mods & MOD_SUPER) parts.push('Super');
  const k = hotkey.key;
  let key: string | undefined;
  if (/^Key[A-Z]$/.test(k)) key = k.slice(3);
  else if (/^Digit[0-9]$/.test(k)) key = k.slice(5);
  else if (/^Numpad[0-9]$/.test(k)) key = `num${k.slice(6)}`;
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(k)) key = k;
  else key = ACCELERATOR_KEYS[k];
  if (key === undefined) return null;
  parts.push(key);
  return parts.join('+');
}

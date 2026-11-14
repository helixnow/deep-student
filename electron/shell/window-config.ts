/**
 * Strict decoder for one `app.windows[]` element, following tauri-utils 2.9.3 `config.rs`
 * `WindowConfig` (`rename_all = "camelCase", deny_unknown_fields`, kebab-case aliases) and the
 * nested `Color`, `LogicalPosition`, `PreventOverflowConfig`, `WindowEffectsConfig`, `Theme`,
 * `TitleBarStyle`, `BackgroundThrottlingPolicy`, `ScrollBarStyle` types (config.rs, lib.rs).
 *
 * Fields that are present are type-checked and normalised; absent fields stay absent so the
 * Rust `WindowConfig::default` values keep a single home in `window-options.ts`.
 * Limitation: after `JSON.parse`, `1.0` and `1` are indistinguishable, so u8/u32 accept both.
 */
import { unexpectedOf } from '../../host/kernel/api.ts';
import type { TauriWindowConfig } from './tauri-config.ts';

type Obj = Record<string, unknown>;
type Decode = (value: unknown) => unknown;
interface Field { name: string; aliases: string[]; decode: Decode; option: boolean }

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const invalidType = (v: unknown, expected: string) => new Error(`invalid type: ${unexpectedOf(v)}, expected ${expected}`);

const str: Decode = (v) => {
  if (typeof v !== 'string') throw invalidType(v, 'a string');
  return v;
};
const bool: Decode = (v) => {
  if (typeof v !== 'boolean') throw invalidType(v, 'a boolean');
  return v;
};
const f64: Decode = (v) => {
  if (typeof v !== 'number') throw invalidType(v, 'f64');
  return v;
};
const uint = (max: number, name: string): Decode => (v) => {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw invalidType(v, name);
  if (v < 0 || v > max) throw new Error(`invalid value: integer \`${v}\`, expected ${name}`);
  return v;
};
const u8 = uint(255, 'u8');
const u32 = uint(0xffff_ffff, 'u32');

function unitEnum(variants: readonly string[]): Decode {
  return (v) => {
    const name = str(v) as string;
    if (!variants.includes(name)) {
      throw new Error(`unknown variant \`${name}\`, expected ${variants.length === 1 ? `\`${variants[0]}\`` : `one of ${variants.map((x) => `\`${x}\``).join(', ')}`}`);
    }
    return name;
  };
}

function tuple(len: number, item: Decode, expected: string): Decode {
  return (v) => {
    if (!Array.isArray(v)) throw invalidType(v, expected);
    if (v.length !== len) throw new Error(`invalid length ${v.length}, expected ${expected}`);
    return v.map(item);
  };
}

/** serde struct: unknown keys rejected only when `denyUnknown`; duplicates always rejected. */
function struct(fields: Field[], denyUnknown: boolean, required: string[] = []): (v: unknown, expected: string) => Obj {
  return (v, expected) => {
    if (!isObj(v)) throw invalidType(v, expected);
    const out: Obj = {};
    const seen = new Set<string>();
    for (const [key, value] of Object.entries(v)) {
      // IPC values arrive by structured clone; JSON (and so serde) never sees undefined members.
      if (value === undefined) continue;
      const field = fields.find((f) => f.name === key || f.aliases.includes(key));
      if (!field) {
        if (denyUnknown) throw new Error(`unknown field \`${key}\`, expected ${fields.length === 1 ? `\`${fields[0]?.name}\`` : `one of ${fields.map((f) => `\`${f.name}\``).join(', ')}`}`);
        continue;
      }
      if (seen.has(field.name)) throw new Error(`duplicate field \`${field.name}\``);
      seen.add(field.name);
      if (field.option && value === null) continue;
      out[field.name] = field.decode(value);
    }
    for (const name of required) if (!seen.has(name)) throw new Error(`missing field \`${name}\``);
    return out;
  };
}

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
/** `#[serde(alias = "kebab-case")]` field; `alias: false` for fields without an alias. */
const field = (name: string, decode: Decode, opts: { option?: boolean; alias?: boolean; extra?: string[] } = {}): Field => ({
  name,
  aliases: [...(opts.alias === false ? [] : [kebab(name)].filter((a) => a !== name)), ...(opts.extra ?? [])],
  decode,
  option: opts.option ?? false,
});

/** u8::from_str_radix(s, 16) for a 2-byte slice (a leading `+` is accepted). */
function hexByte(s: string): number {
  const digits = s.startsWith('+') ? s.slice(1) : s;
  if (digits === '' || !/^[0-9a-fA-F]+$/.test(digits)) throw new Error('invalid digit found in string');
  return Number.parseInt(digits, 16);
}

/** `Color` (untagged `InnerColor`): hex string, `[r,g,b]`, `[r,g,b,a]` or `{red,green,blue,alpha?}` → RGBA. */
export function decodeColor(v: unknown): [number, number, number, number] {
  if (typeof v === 'string') {
    let color = v.trim();
    if (color.startsWith('#')) color = color.slice(1);
    // Rust indexes bytes; non-ASCII input cannot form valid hex digits.
    if (!/^[\x00-\x7f]*$/.test(color)) throw new Error('invalid digit found in string');
    if (color.length === 3) color = [...color].map((c) => c + c).join('') + 'ff';
    else if (color.length === 6) color += 'FF';
    else if (color.length !== 8) throw new Error('Invalid hex color length, must be either 3, 6 or 8, for example: #fff, #ffffff, or #ffffffff');
    return [hexByte(color.slice(0, 2)), hexByte(color.slice(2, 4)), hexByte(color.slice(4, 6)), hexByte(color.slice(6, 8))];
  }
  const fail = () => new Error('data did not match any variant of untagged enum InnerColor');
  if (Array.isArray(v)) {
    if ((v.length !== 3 && v.length !== 4) || !v.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) throw fail();
    return [v[0], v[1], v[2], v.length === 4 ? v[3] : 255] as [number, number, number, number];
  }
  if (isObj(v)) {
    const byte = (x: unknown) => (Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 255 ? (x as number) : null);
    const [r, g, b] = [byte(v.red), byte(v.green), byte(v.blue)];
    const a = 'alpha' in v ? byte(v.alpha) : 255;
    if (r === null || g === null || b === null || a === null) throw fail();
    return [r, g, b, a];
  }
  throw fail();
}

const seq = (item: Decode): Decode => (v) => {
  if (!Array.isArray(v)) throw invalidType(v, 'a sequence');
  return v.map(item);
};

const WINDOW_EFFECTS = [
  'appearanceBased', 'light', 'dark', 'mediumLight', 'ultraDark', 'titlebar', 'selection', 'menu', 'popover',
  'sidebar', 'headerView', 'sheet', 'windowBackground', 'hudWindow', 'fullScreenUI', 'tooltip', 'contentBackground',
  'underWindowBackground', 'underPageBackground', 'mica', 'micaDark', 'micaLight', 'tabbed', 'tabbedDark',
  'tabbedLight', 'blur', 'acrylic',
] as const;

const logicalPosition = struct([field('x', f64, { alias: false }), field('y', f64, { alias: false })], true, ['x', 'y']);
const margin = struct([field('width', u32, { alias: false }), field('height', u32, { alias: false })], true, ['width', 'height']);
const windowEffects = struct([
  field('effects', seq(unitEnum(WINDOW_EFFECTS)), { alias: false }),
  field('state', unitEnum(['followsWindowActiveState', 'active', 'inactive']), { option: true, alias: false }),
  field('radius', f64, { option: true, alias: false }),
  field('color', decodeColor, { option: true, alias: false }),
], true, ['effects']);

const opt = { option: true } as const;
const WINDOW_FIELDS: Field[] = [
  field('label', str),
  field('create', bool),
  field('url', str),
  field('userAgent', str, opt),
  field('dragDropEnabled', bool),
  field('center', bool),
  field('x', f64, opt),
  field('y', f64, opt),
  field('width', f64),
  field('height', f64),
  field('minWidth', f64, opt),
  field('minHeight', f64, opt),
  field('maxWidth', f64, opt),
  field('maxHeight', f64, opt),
  field('preventOverflow', (v) => {
    if (typeof v === 'boolean') return v;
    try {
      return margin(v, 'struct PreventOverflowMargin');
    } catch {
      throw new Error('data did not match any variant of untagged enum PreventOverflowConfig');
    }
  }, opt),
  field('resizable', bool),
  field('maximizable', bool),
  field('minimizable', bool),
  field('closable', bool),
  field('title', str),
  field('fullscreen', bool),
  field('focus', bool),
  field('focusable', bool),
  field('transparent', bool),
  field('maximized', bool),
  field('visible', bool),
  field('decorations', bool),
  field('alwaysOnBottom', bool),
  field('alwaysOnTop', bool),
  field('visibleOnAllWorkspaces', bool),
  field('contentProtected', bool),
  field('skipTaskbar', bool),
  field('windowClassname', str, { option: true, alias: false }),
  // `Theme`: "dark" (case-insensitive) → Dark, any other string → Light.
  field('theme', (v) => ((str(v) as string).toLowerCase() === 'dark' ? 'dark' : 'light'), opt),
  // `TitleBarStyle`: transparent / overlay (case-insensitive), any other string → Visible.
  field('titleBarStyle', (v) => {
    const s = (str(v) as string).toLowerCase();
    return s === 'transparent' ? 'Transparent' : s === 'overlay' ? 'Overlay' : 'Visible';
  }),
  field('trafficLightPosition', (v) => logicalPosition(v, 'struct LogicalPosition'), opt),
  field('hiddenTitle', bool),
  field('acceptFirstMouse', bool),
  field('tabbingIdentifier', str, opt),
  field('additionalBrowserArgs', str, opt),
  field('shadow', bool),
  field('windowEffects', (v) => windowEffects(v, 'struct WindowEffectsConfig'), opt),
  field('incognito', bool),
  field('parent', str, opt),
  field('proxyUrl', (v) => {
    const s = str(v) as string;
    if (!URL.canParse(s)) throw new Error('relative URL without a base');
    return s;
  }, opt),
  field('zoomHotkeysEnabled', bool),
  field('browserExtensionsEnabled', bool),
  field('useHttpsScheme', bool),
  field('devtools', bool, opt),
  field('backgroundColor', decodeColor, opt),
  field('backgroundThrottling', unitEnum(['disabled', 'suspend', 'throttle']), opt),
  field('javascriptDisabled', bool),
  field('allowLinkPreview', bool),
  field('disableInputAccessoryView', bool, { extra: ['disable_input_accessory_view'] }),
  field('dataDirectory', str, opt),
  field('dataStoreIdentifier', tuple(16, u8, 'an array of length 16'), opt),
  field('scrollBarStyle', unitEnum(['default', 'fluentOverlay'])),
  field('activityName', str, opt),
  field('createdByActivityName', str, opt),
  field('requestedBySceneIdentifier', str, opt),
  field('generalAutofillEnabled', bool),
];

const windowStruct = struct(WINDOW_FIELDS, true);

export function decodeWindowConfig(value: unknown): TauriWindowConfig {
  return windowStruct(value, 'struct WindowConfig') as TauriWindowConfig;
}

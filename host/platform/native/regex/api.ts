/**
 * `regex` crate boundary (`nativeRegex`).
 *
 * Rust code uses `regex::Regex`; JavaScript `RegExp` is a different dialect and
 * a different implementation.  This service runs the exact `regex = 1.12.3`
 * crate in the shared F7 WASI engine.
 *
 * `start`/`end` positions are UTF-16 code-unit offsets, i.e. indices into the
 * JavaScript string; the Rust crate's byte offsets are converted inside the
 * engine.
 */
export interface NativeRegexPattern {
  readonly pattern: string;
}

export interface RegexMatch {
  /** UTF-16 code-unit offset in the input string. */
  start: number;
  /** UTF-16 code-unit offset in the input string. */
  end: number;
  text: string;
}

export interface RegexGroup extends RegexMatch {
  /** Named capture (`(?P<name>…)`), or `null` for an unnamed group. */
  name: string | null;
}

export interface RegexCaptures extends RegexMatch {
  /** Index 0 is the whole match; optional groups are `null`. */
  groups: Array<RegexGroup | null>;
}

/** Result of {@link NativeRegex.replaceAllProjected}; a failure never carries the value. */
export type RegexProjectedReplacement =
  | { ok: true; value: string; bytes: number }
  | { ok: false; bytes: number };

export interface NativeRegex {
  /**
   * Compile with `regex::Regex::new`.  Rejects with
   * {@link NativeRegexCompileError} whose `message` is the crate's own
   * `regex::Error` `Display` text.
   */
  compile(pattern: string): Promise<NativeRegexPattern>;
  isMatch(pattern: NativeRegexPattern, text: string): Promise<boolean>;
  findIter(pattern: NativeRegexPattern, text: string): Promise<RegexMatch[]>;
  captures(pattern: NativeRegexPattern, text: string): Promise<RegexCaptures | null>;
  /** `Regex::replace`: first match only.  Replacement uses Rust `$name`/`${1}`/`$$` syntax. */
  replace(pattern: NativeRegexPattern, text: string, replacement: string): Promise<string>;
  /** `Regex::replace_all`. */
  replaceAll(pattern: NativeRegexPattern, text: string, replacement: string): Promise<string>;
  /**
   * `chatanki_transform.rs::bounded_regex_replace` with the caller's allocation limit:
   * walks `captures_iter(text)` adding each literal gap and the exact UTF-8 length of the
   * expanded replacement (`$name`/`$1`/`${..}`/`$$`), then the tail. The first cumulative
   * count `> limitBytes` is returned as `{ ok: false, bytes }` before anything is replaced;
   * otherwise `{ ok: true, value: replace_all(..), bytes: utf8Bytes(value) }`. Counters are
   * u64 in the engine. `limitBytes` must be a non-negative safe integer.
   */
  replaceAllProjected(pattern: NativeRegexPattern, text: string, replacement: string,
    limitBytes: number): Promise<RegexProjectedReplacement>;
  /** `Regex::split`, including the trailing empty piece after a final match. */
  split(pattern: NativeRegexPattern, text: string): Promise<string[]>;
}

export class NativeRegexCompileError extends Error {
  readonly pattern: string;
  constructor(pattern: string, message: string) {
    super(message);
    this.name = 'NativeRegexCompileError';
    this.pattern = pattern;
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { nativeRegex: NativeRegex }
}

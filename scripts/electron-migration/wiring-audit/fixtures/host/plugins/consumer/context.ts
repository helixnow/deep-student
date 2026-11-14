/** Local structural types only. Deliberately missing runtime services stay missing. */
export interface Context {
  real: { run(): unknown };
  rpc: { run(): unknown };
  bracketMissing?: unknown;
  get(name: string): unknown;
  inject(names: readonly string[], listener: (ctx: Context) => unknown): unknown;
  provide(name: string, value: unknown): void;
}

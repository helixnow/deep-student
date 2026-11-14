/** Builds an explicit "owner method absent" host state, independent of which L04 surface main carries. */
export async function withoutOwnerMethods<T>(service: object, names: readonly string[], run: () => Promise<T>): Promise<T> {
  const target = service as Record<string, unknown>;
  const saved = names.map(name => [name, Object.getOwnPropertyDescriptor(target, name)] as const);
  for (const name of names) Object.defineProperty(target, name, { value: undefined, configurable: true, writable: true });
  try { return await run(); }
  finally {
    for (const [name, descriptor] of saved) {
      if (descriptor === undefined) delete target[name];
      else Object.defineProperty(target, name, descriptor);
    }
  }
}

export type Unlisten = () => void | Promise<void>;

export async function guardedListen<T = any>(
  _event: string,
  _handler: (event: { event: string; id: number; payload: T }) => void
): Promise<Unlisten> {
  return () => undefined;
}

export default { guardedListen };

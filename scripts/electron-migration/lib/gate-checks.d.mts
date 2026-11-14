export interface GateCheck {
  name: string;
  bin: string;
  args: string[];
  env?: Record<string, string>;
  serial?: boolean;
}
export function gateChecks(cwd: string, base: string, options?: { quick?: boolean; tests?: boolean }): GateCheck[];

export interface ScannedPlugin { id: string | null; lane: string | null; commands: string[]; unresolvedCommands: boolean; line: number }
export function scanPluginFile(rel: string, text: string): {
  plugins: ScannedPlugin[];
  registers: { command: string; line: number }[];
  dynamicRegisters: number;
  objectKeys: Set<string>;
};

export interface ChunkCycle {
  members: string[];
  loop: string[];
  steps: { from: string; to: string; imports: string[] }[];
  chunks: Record<string, { modules: number; virtual: string[]; sample: string[] }> | null;
}

export function chunkCycles(dist: string): ChunkCycle[];
export function formatCycle(cycle: ChunkCycle): string;
export function bootProblems(dist: string): Promise<string[]>;
export function bootCheck(dist?: string): Promise<string[]>;

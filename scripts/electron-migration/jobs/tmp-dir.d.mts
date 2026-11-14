export interface JobTmpOptions {
  jobsDir: string;
  env?: Record<string, string | undefined>;
  osTmpdir?: string;
  user?: string;
}
export function hasHiddenComponent(p: string): boolean;
export function jobTmpRoot(options: JobTmpOptions): string;
export function jobTmpDir(jobId: string, options: JobTmpOptions): string;

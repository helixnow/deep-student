export const LATEST_FULLTEST: string;
export interface VitestAssertion { title: string; fullName: string; status: string }
export interface ReportProvenance { path: string; head: string | null; at: string | null; files: number; tests: number }
export interface MergedReports { results: Map<string, VitestAssertion[]>; provenance: ReportProvenance[]; overridden: string[] }
export function repoRelativeTestPath(name: string, root: string, exists?: (rel: string) => boolean): string;
export function expandReportArgs(args: readonly string[], root: string): string[];
export function mergeVitestReports(reports: { path: string; report: unknown }[], root: string, exists?: (rel: string) => boolean): MergedReports;
export function loadVitestReports(args: readonly string[], root: string): MergedReports;

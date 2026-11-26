export const BUILD_BASELINE: string;
export const TEST_BUILD_NUMBER: string;
export function baselineAvailable(root: string): boolean;
export function testBuildNumberEnv(
  root: string,
  options?: { env?: Record<string, string | undefined>; hasBaseline?: (root: string) => boolean },
): Record<string, string>;

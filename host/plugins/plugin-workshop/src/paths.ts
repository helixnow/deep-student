import path from 'node:path';
export function isManagedChild(root: string, candidate: string, flavor: Pick<typeof path, 'resolve' | 'relative' | 'isAbsolute' | 'sep'> = path): boolean {
  const rel = flavor.relative(flavor.resolve(root), flavor.resolve(candidate));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${flavor.sep}`) && !flavor.isAbsolute(rel);
}

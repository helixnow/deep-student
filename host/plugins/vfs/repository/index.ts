/**
 * Aggregate write/read repositories published for other lanes (L13b).
 * Rust: dstu_vfs::vfs::repos. Namespace re-exports keep the module boundary visible
 * to consumers without duplicating symbols.
 */
export * as create from './create.ts';
export * as database from './database.ts';
export * as delete from './delete.ts';
export * as folders from './folders.ts';
export * as json from './json.ts';
export * as locations from './locations.ts';
export * as resources from './resources.ts';
export * as studySpaces from './study-spaces.ts';
export * as update from './update.ts';

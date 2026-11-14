import type { InsertScene } from '../timeline/insert';
import { INSERTS as DELEGATE } from './delegate';
import { INSERTS as DESKTOP } from './desktop';
import { INSERTS as EXAM } from './exam';
import { INSERTS as PLATFORM } from './platform';
import { INSERTS as READER } from './reader';
import { INSERTS as TUTOR } from './tutor';

/** 全部插入段，按切入点排序。各段在自己的目录里登记（src/inserts/<名字>/index.ts）。 */
export const ALL_INSERTS: InsertScene[] = [...TUTOR, ...READER, ...DESKTOP, ...EXAM, ...DELEGATE, ...PLATFORM].sort((a, b) => a.at - b.at);

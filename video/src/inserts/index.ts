import type { InsertScene } from '../timeline/insert';
import { INSERTS as DELEGATE } from './delegate';
import { INSERTS as DESKTOP } from './desktop';
import { INSERTS as EXAM } from './exam';
import { INSERTS as PLATFORM } from './platform';
import { INSERTS as READER } from './reader';
import { INSERTS as TUTOR } from './tutor';

/**
 * 全部插入段，按切入点排序。各段在自己的目录里登记（src/inserts/<名字>/index.tsx）。
 *
 * 工程铁律：所有功能界面展示一律禁止自绘/手写“模拟假组件”，必须直接从主仓 `@/` 导入
 * 完整真实的 Node 前端组件，并经 `AppSurface`、`Staged` 与 `shims/tauri-core` 真实驱动渲染。
 * 详见 `video/CONVENTIONS.md`。
 */
export const ALL_INSERTS: InsertScene[] = [...TUTOR, ...READER, ...DESKTOP, ...EXAM, ...DELEGATE, ...PLATFORM].sort((a, b) => a.at - b.at);

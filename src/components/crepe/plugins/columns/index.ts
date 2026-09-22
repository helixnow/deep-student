import type { MilkdownPlugin } from '@milkdown/ctx'
import { columnsBehavior } from './behavior'
import type { ColumnsOptions } from './config'
import { remarkColumnsPlugin } from './remark'
import { columnsSchema, columnSchema } from './schema'
import './styles.css'

export * from './format'
export * from './config'
export * from './commands'
export * from './export'
export { createColumnsValidator } from './behavior'
export { columnsSchema, columnSchema } from './schema'
export { remarkColumns, remarkColumnsPlugin, parseColumnsTree } from './remark'

/** Register before editor.create(). Writing defaults closed until the host has
 * performed its per-page format upgrade. No input rule implicitly creates layout. */
export function columnsPlugin(options: ColumnsOptions = { canWrite: () => false }): MilkdownPlugin[] {
  return [remarkColumnsPlugin, columnsSchema, columnSchema, columnsBehavior(options)].flat()
}

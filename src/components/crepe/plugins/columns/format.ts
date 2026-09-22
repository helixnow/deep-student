export const COLUMNS_TYPE = 'ds_columns'
export const COLUMN_TYPE = 'ds_column'
/** This is the directive version, not the enclosing note formatVersion. */
export const COLUMNS_SYNTAX_VERSION = 1
export const COLUMNS_REQUIRED_CAPABILITY = 'ds-columns-v1'
export type ColumnsLayout = 'equal' | 'cornell'

export const COLUMN_OPEN = ':::column'
export const COLUMN_CLOSE = ':::end-column'
export const COLUMNS_CLOSE = ':::end-ds-columns'
export const columnsOpen = (layout: ColumnsLayout) => `:::ds-columns{version=1 layout=${layout}}`

export function parseColumnsOpen(value: string): ColumnsLayout | null {
  const match = /^:::ds-columns\{version=1 layout=(equal|cornell)\}$/.exec(value)
  return match ? match[1] as ColumnsLayout : null
}

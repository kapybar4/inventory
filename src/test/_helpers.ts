/**
 * 测试辅助。放在源码里是因为 tsconfig 的 rootDir 是 src/，
 * 放到 src 之外会被 TS 拒绝编译。
 */
import { exportedFields, tableDef } from '../core/fields';

/** 某张表在导入导出中出现的列名，顺序与导出 CSV 表头一致 */
export function exportTableColumns(tableName: string): string[] {
  return exportedFields(tableDef(tableName)).map((f) => f.name);
}

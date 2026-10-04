/**
 * 应用与格式的标识常量，集中一处避免拼写漂移。
 *
 * `APP_NAME` 是**给人看的**（窗口标题栏、`--version`、归档 README）；
 * 下面两个 `inventory-*` 是**机器标识**，写进归档 manifest 与 registry.json，
 * 读取时严格比对。它们不跟随显示名变化 —— 改一次，以前导出的归档与新写的
 * 注册表就都成了另一种格式。
 */
export const APP_NAME = 'Inventory';
export const APP_VERSION = '0.1.0';

/** 归档格式标识：写进 manifest.format，导入时严格比对 */
export const APP_FORMAT = 'inventory-archive';
/** 归档格式版本：结构不兼容变更时 +1 */
export const APP_FORMAT_VERSION = 1;

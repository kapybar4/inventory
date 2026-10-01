/**
 * 应用与格式的标识常量，集中一处避免拼写漂移。
 *
 * `APP_NAME` 是**给人看的**，所以不带前缀 —— 窗口标题栏、`--version`、
 * 归档 README 里都用它。下面那几个 `dsh-inventory-*` 是**机器标识**：
 * 改了老归档就读不回来、老数据目录也找不到，所以跟显示名分开，别一起改。
 */
export const APP_NAME = 'Inventory';
export const APP_VERSION = '0.1.0';

/** 归档格式标识：写进 manifest.format，导入时严格比对。**不要改** */
export const APP_FORMAT = 'dsh-inventory-archive';
/** 归档格式版本：结构不兼容变更时 +1 */
export const APP_FORMAT_VERSION = 1;

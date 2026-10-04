# Inventory

家庭物品管理工具。**多工作区、每个工作区一个独立 SQLite 文件，外加一套完整的命令行工具。**

核心用途是**在物品临期时主动提醒**：顶部横幅、`alert list` 命令与概览页都在回答同一个问题——"哪些东西该处理了"。

许可证：[MIT](LICENSE)。

---

## 安装

需要 Node 24 与 npm。本机若执行策略禁止 `npm.ps1`，请用 `npm.cmd`，
或执行 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` 一次性解决。

```bash
git clone https://github.com/kapybar4/inventory.git
cd inventory
npm.cmd install
npm.cmd run build
```

依赖只有 `typescript` / `electron` / `electron-builder`，**运行时零依赖**
（CSV 解析、参数解析、zip 打包都是自己实现或调用系统能力）。

### 打个包分发给别人

别人不想装 Node 时，可以打一个自包含的文件夹给他：

```bash
npm.cmd run release     # 产出 release/Inventory/
```

里面有 `start.cmd`、`Inventory.exe` 与整份 Electron 运行时（约 370MB）。
对方解压后双击 `start.cmd` 即可，**不需要 Node，也不需要 `npm install`**。

- **首次启动是空的**，需自行新建工作区。
- **`data/` 在程序旁边。** 整个文件夹拷到别的机器，数据跟着走，无需配置路径。
  代价是**别放进 `Program Files`** 这类受保护目录——那里写不进去，
  程序会整页置灰、只保留「设置数据目录」可用。
- **更新版本：** 替换整个文件夹，**保留 `data/`**。

打包过程**完全离线**（用 `node_modules/electron` 里已有的 Electron，
不访问 github.com），所以必须先跑过一次 `npm.cmd install`。

---

## 快速开始

```bash
npm.cmd run cli -- --help                      # 命令行工具
npm.cmd run cli -- init --name "我的家"          # 初始化（工作区是空的）
npm.cmd run cli -- ws seed                     # 可选：写入示例数据
npm.cmd run cli -- alert list                  # 看哪些东西要处理

npm.cmd start                                  # 桌面界面
```

想先试而不碰正式数据，用隔离的数据目录：

```bash
$env:INVENTORY_HOME = "$env:TEMP\inv-demo"
npm.cmd run cli -- init --name "试一下"
```

> 若环境中设了 `ELECTRON_RUN_AS_NODE=1`，Electron 会以 Node 模式启动而不开窗口。
> 启动界面前清除：`$env:ELECTRON_RUN_AS_NODE = $null`。

---

## 核心概念

**一行 = 一件实际存在的物品。** 同一物品买两次就是两条记录，各自管自己的到期日。

| 概念 | 说明 |
| --- | --- |
| **工作区** | 一套独立数据，一个目录一个 `.db` 文件。互不感知，拷贝目录即完成迁移 |
| **批量物品** | 需按个数管理的物品（抽纸、电池），加 `--bulk` 开启。默认物品数量恒为 1，点一下即消耗掉 |
| **一组库存** | 批量物品分批购买、各批到期日不同时，可拆成多条库存条目，领用按先到期先出 |
| **长期** | 不设到期日的物品（护照、雨伞）。不参与任何到期计算 |
| **过期 / 过保** | **分开统计**。前者是保质期、开封后有效期（东西坏了）；后者是质保期（只是不保修了）。顶部高亮与 `alert` 只数过期 |
| **快到期** | 指 **15 天内**到期。第 15 天算，第 16 天不算；不含过保 |
| **未分类** | 分类可以留空。未分类分组恒置顶且不可拖动 |
| **顺序号** | 隐藏的手动排序位次，由拖动或 `item reorder` 决定。任何排序都不修改它，关掉排序即回到手动顺序 |

### 品牌 / 型号 / 规格

三个独立选填字段，互不影响：

| 字段 | 回答的问题 | 示例 |
| --- | --- | --- |
| **品牌** | 制造商 | 芬必得 / Anker / 罗技 |
| **型号** | 具体款式 | MX Master 3S / A1287 |
| **规格** | 单份容量 | 0.3g×20粒 / 20000mAh |

### 展开区

物品表每行最左侧的箭头，展开后显示并可直接编辑位置、规格、备注，
**以及任意条该物品专属的字段**（空调的「滤网型号」、保单的「保单号」）。
修改在离开输入框时自动保存，无需点保存。清空值即删除该字段。

### 表格列

物品表显示哪些列可自行配置（界面为工具栏「列设置」，命令行为 `column set`）。
**「物品」与「到期时间」不可关闭**——少了这两列这张表就不成立。
「剩余时间」不是独立一列，由到期日算得，会随时间自动更新。

---

## 桌面界面

四个页面，顶栏工作区下拉左侧的返回箭头进入工作区管理：

| 页面 | 内容 |
| --- | --- |
| **概览** | 最先到期 8 项 + 待补货 2 项，已过期的行带快速删除 |
| **分组** | 按分类分组，组内可点列头旁的 ▲ / ▼ 排序，未排序的组可拖动 |
| **明细** | 全部物品，支持搜索、分类筛选、列设置、勾选批量删除 |
| **工作区** | 新建 / 切换 / 编辑 / 删除 / 导出 / 导入，并显示各工作区的待办条数 |

两个筛选开关：

- **简明视图**：只看已过期的与 15 天内到期的。是筛选开关，不影响分组、排序与列设置。
- **只看已过期**（明细页）：只看已经变质的。与简明视图互不冲突。

---

## 命令行工具

源码目录里的调用形式：

```bash
npm.cmd run cli -- <命令> [选项]
```

下文示例统一写成 `npm.cmd run cli -- item list` 这样的形式；
若你另装了全局的 `inventory` 命令，把前缀去掉即可。

> 本仓库**不要**用 `npm link` 生成全局 `inventory` 命令：包名与命令名相同，
> `npm link` 会把包链进全局 `node_modules` 并生成一个指向自身的启动器，
> 调用它会无限递归（表现为命令挂住不返回）。需要全局命令时，
> 从仓库外的目录执行 `npm i -g <本仓库路径>`。

默认输出人读表格；加 `--json` 输出单个可解析的 JSON 对象。

```console
$ npm.cmd run cli -- alert list --within 30

药品 ──────────────────────────────────────────── 4 项 · 3 已过期 · 1 项 15 天内
  类型          名称                            到期日      剩余时间      状态    数量  位置
  ────────────  ──────────────────────────────  ──────────  ────────────  ──────  ────  ──────────────
  保质期        布洛芬缓释胶囊                  2026-07-31  已过期 65 天  已过期     1  客厅药箱-上层
  开封后有效期  左氧氟沙星滴眼液                2026-09-22  已过期 12 天  已过期     1  卧室床头柜抽屉
  开封后有效期  对乙酰氨基酚口服混悬液（儿童）  2026-09-24  已过期 10 天  已过期     1  客厅药箱-上层
  保质期        布洛芬缓释胶囊                  2026-10-18  剩 14 天                 1  客厅药箱-上层

食品 ──────────────────────────────────────────────── 3 项 · 2 项 15 天内
  类型          名称            到期日      剩余时间  状态  数量  位置
  ────────────  ──────────────  ──────────  ────────  ────  ────  ──────────
  开封后有效期  婴儿配方奶粉    2026-10-07  剩 3 天            1  厨房吊柜
  开封后有效期  意式浓缩咖啡豆  2026-10-11  剩 7 天            1  厨房咖啡角
  保质期        婴儿配方奶粉    2026-10-24  剩 20 天           1  厨房吊柜

其他 ─────────────────────────────────────────────────────────────── 0 项
  长期：雨伞

○ 待补货 ─────────────────────────────────────────────────────────── 2 项
  名称         剩余  下限   缺
  ───────────  ────  ────  ───
  洗衣凝珠        1     2    1
  5号碱性电池     1     2    1
```

（上例省略了「物品UUID」一列——那是给人复制粘贴用的定位符。）

### 命令一览

```
npm.cmd run cli -- info                                应用与数据目录概况
npm.cmd run cli -- init [--name 名称]                  初始化数据目录与第一个工作区

工作区
  ws list                                     列出所有工作区
  ws create --name 名称                       新建工作区
  ws show [工作区]                            详情 + 提醒摘要
  ws stats [工作区]                           按分类 / 状态 / 位置分布、金额合计
  ws verify [工作区]                          完整性 / 外键 / 结构版本自检
  ws use <工作区>                             设为默认
  ws rename <工作区> <新名称>                 重命名
  ws rm <工作区> --yes                        删除（默认先留数据库快照）
  ws seed [工作区]                            往**空**工作区写入示例数据

物品
  item add --name 名称 [字段选项]             新增（--brand / --model / --spec 均选填）
  item list [筛选] [--limit N]                列出物品
  item show <uuid|code>                       完整信息：字段 + 到期情况 + 出入库流水
  item update <uuid|code> [字段选项]          修改字段
  item consume <uuid|code> [--qty N]          消耗 / 领用 / 丢弃 / 过期处理
  item reorder <物品>... [--after <物品>]     调整手动顺序（等于拖动）
  item extra <物品> [<字段> <值>]            位置 / 规格 / 备注 + 自定义字段
  item stock <list|add|rm> <物品>             管理批量物品的「一组库存」
  item purge [--dry-run] [--yes]              清理「已消耗完」的普通物品
  item rm <uuid|code> [更多...] --yes         删除记录（连带流水）

分组与列
  group list [--levels 1|2|3] [--sort 字段]   分组（界面固定一级，命令行可要多级）
  sort fields                                 列出可用的排序字段
  column list                                 查看物品表有哪些列、当前开启哪些
  column set <列>... | --default | --show-all 设置显示哪些列

提醒与时间轴
  alert list [--within N] [--all]             临期 / 过期 / 待补货清单
  timeline [--category 分类]                  横向时间轴（**仅命令行**，界面无此页面）

导入导出与维护
  export [-o 文件.zip] [--ws 工作区]          导出工作区
  import <文件.zip> [--name 名称] [--dry-run] 导入为新工作区
  schema show                                 字段定义与枚举
  enums                                       分类、状态、预警阈值
  config data-dir <路径>                      设置数据目录
```

### 常见用法

```bash
# 录入：价格与到期日记录在该条记录自身
npm.cmd run cli -- item add --name "布洛芬缓释胶囊" -c medicine --brand "芬必得" --spec "0.3g×20粒" \
                   --unit 盒 --container 客厅药箱-上层 \
                   --expires-ym 2027-03 --unit-price 19.30 --store 京东健康

# 同一物品又买一盒、到期日不同 → 再 add 一条
npm.cmd run cli -- item add --name "布洛芬缓释胶囊" -c medicine --expires-on 2026-10-15

# 批量物品：确实要按个数管理时才开 --bulk
npm.cmd run cli -- item add --name "抽纸巾" -c daily --bulk --qty 24 --remaining 24 --min-stock 6

# 查
npm.cmd run cli -- alert list --within 15
npm.cmd run cli -- item list --low-stock
npm.cmd run cli -- item list --expiring 60 --category medicine

# 用
npm.cmd run cli -- item consume MED-0001                            # 普通物品一次消耗掉
npm.cmd run cli -- item consume DAY-0001 --qty 3                    # 批量物品领用 3 个
npm.cmd run cli -- item consume MED-0002 --reason expired_dispose   # 过期处理

# 批量录入：写一个 JSON 数组文件
npm.cmd run cli -- item add --json-file 购物清单.json
cat 购物清单.json | inventory item add --stdin

# 维护
npm.cmd run cli -- ws stats
npm.cmd run cli -- ws verify
npm.cmd run cli -- export -o D:\备份\家当.zip
npm.cmd run cli -- import D:\备份\家当.zip --dry-run      # 先看报告
npm.cmd run cli -- import D:\备份\家当.zip --name "父母家"
```

批量录入的 JSON（键名同时接受列名与驼峰写法）：

```json
[
  { "name": "创可贴", "category": "medical_device", "brand": "云南白药",
    "spec": "100片/盒", "unit": "盒", "container": "客厅药箱-下层",
    "qty": 1, "minStock": 1, "expiresYm": "2028-06", "unitPrice": "29.90" },
  { "name": "洗手液", "category": "daily", "brand": "蓝月亮",
    "unit": "瓶", "container": "卫生间镜柜", "qty": 2, "remaining": 2, "minStock": 2,
    "notes": "补充装在储物间" }
]
```

支持的键（下划线列名与驼峰写法都可以）：`name` `category` `subcategory` `brand` `model`
`spec` `unit` `barcode` `container` `sortOrder` `photo_path` `quantity` `remaining`
`minStock` `unitPrice` `amount` `store` `purchasedOn` `expiresOn` `expiresYm` `openedOn`
`openShelfLifeDays` `warrantyMonths` `warrantyUntil` `serial` `status` `is_bulk`
`prescription` `tags` `notes`

两点注意：

- **无法识别的键会被静默丢弃**，不报错。键名写错不会有任何提示，只是该字段没写进去——
  提交前用 `--dry-run` 核对更稳妥。
- **非批量物品的 `minStock` 会被归 0**，这是写入层强制的（数量恒为 1，最低库存无意义），
  不是参数没生效。要设最低库存请同时加 `"bulk": true`。

---

## 给脚本与 agent 的约定

1. **`--json` 时 stdout 只有一个 JSON 对象**，日志全部走 stderr
2. 信封固定：`{ ok, data, warnings, meta }`
3. 退出码：`0` 成功 / `1` 运行错误 / `2` 参数错误 / `3` 数据校验失败 / `4` 未找到
4. 所有写操作支持 `--dry-run`；破坏性操作要 `--yes`；**永不交互式提问**
5. 各命令的 `--help` 是唯一的使用文档

---

## 数据位置

默认是**程序目录下的 `data/`**，一个工作区一个子目录：

```
data/
├─ registry.json                工作区索引
├─ workspaces/<id>/
│  ├─ data.db                   SQLite 数据库
│  ├─ meta.json                工作区信息
│  └─ attachments/             附件
└─ backups/                     删除工作区时留下的快照
```

**拷贝整个 `data/` 即完成迁移。** 用环境变量 `INVENTORY_HOME` 可以指向别处。

如果程序所在目录写不进去（例如装在 `Program Files`），界面会整体降级为
「整页置灰、只保留设置数据目录功能」，此时用界面底部的「设置数据目录」指到可写位置，
或用 `inventory config data-dir <路径>`。

---

## 已知限制

- **zip 依赖系统 `tar.exe`**（Windows 10 1803+ 自带）。
- **界面上的「字段与格式」页点不进去**，页签是隐藏的。要看字段定义请用 `schema show`。
- **桌面端表格未做虚拟滚动**，几百行无压力，上万行需要分页。
- 尚无条码扫描与小票 OCR。
- 界面与命令行同时改同一个工作区时**没有并发写协调**（SQLite 的 WAL 保证不损坏，
  但后写的会覆盖先写的字段）。单人使用无影响。
- 界面上的**多选导出**尚未接（数据层与命令行已完成）。

---

## 开发

```bash
npm.cmd run typecheck   # 两套 tsconfig
npm.cmd test            # 109 项单元测试
npm.cmd run test:func   # 149 项 CLI / 数据层功能测试
npm.cmd run test:gui    # 241 项应用端走查断言（真开 Electron，约 40 秒）
```

改代码前请先读 **`AGENTS.md`** —— 那里记录了架构约束、数据不变量，
以及每一条踩过的坑与成因。

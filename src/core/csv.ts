/**
 * 极简 RFC4180 CSV 读写。零依赖，手写以保证「导出什么就能导入什么」。
 *
 * 约定（与 manifest.json 中 csv 段一致）：
 *   - 编码 UTF-8 **带 BOM**（否则 Excel 打开中文乱码）
 *   - 分隔符 `,`，引号 `"`，换行 CRLF
 *   - 写时**所有字段一律加引号**：防止 Excel 把 2027-03 当日期、把 0012345 的前导零吃掉
 *   - 解析时按 RFC4180 处理引号内的逗号与换行
 */

export interface CsvParseResult {
  header: string[];
  rows: string[][];
  /** 解析期发现的问题（行号为 1-based 文件行号） */
  issues: { line: number; message: string }[];
}

export interface CsvParseOptions {
  delimiter?: string;
  /** 期望的表头（规范列名）；提供时检查是否齐全 */
  expectedHeader?: string[];
  /** 表头别名 → 规范列名，用于容忍被改成中文的表头 */
  aliases?: Record<string, string>;
}

const BOM = '\uFEFF';

export function parseCsv(text: string, opts: CsvParseOptions = {}): CsvParseResult {
  const delimiter = opts.delimiter ?? ',';
  const issues: { line: number; message: string }[] = [];

  const src = text.startsWith(BOM) ? text.slice(1) : text;

  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let line = 1;
  let recordStartLine = 1;
  let i = 0;

  const pushField = () => {
    record.push(field);
    field = '';
  };
  const pushRecord = () => {
    pushField();
    // 跳过「全字段为空」的行：Excel 很容易在末尾留下 ,,, 这样的残留
    const allEmpty = record.every((f) => f === '');
    if (!allEmpty) records.push(record);
    record = [];
    recordStartLine = line;
  };

  while (i < src.length) {
    const ch = src[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      if (ch === '\n') line += 1;
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      if (field.length === 0) {
        inQuotes = true;
        i += 1;
        continue;
      }
      // 字段中间出现引号：宽容处理，当作普通字符
      issues.push({ line, message: '字段中间出现未转义的引号，已按普通字符处理' });
      field += ch;
      i += 1;
      continue;
    }

    if (ch === delimiter) {
      pushField();
      i += 1;
      continue;
    }

    if (ch === '\r') {
      if (src[i + 1] === '\n') i += 1;
      pushRecord();
      line += 1;
      i += 1;
      continue;
    }

    if (ch === '\n') {
      pushRecord();
      line += 1;
      i += 1;
      continue;
    }

    field += ch;
    i += 1;
  }

  if (inQuotes) {
    issues.push({ line: recordStartLine, message: '文件在引号未闭合的情况下结束，末尾字段可能不完整' });
  }
  if (field.length > 0 || record.length > 0) pushRecord();

  if (records.length === 0) {
    return { header: [], rows: [], issues };
  }

  const header = records[0]!.map((h) => h.trim());
  const rows = records.slice(1);

  if (opts.expectedHeader) {
    // 只检查「预期列是否齐全」。未知列不在这里报，因为不同调用方
    // 对未知列的容忍度不同（导入层会把它降级成 warning）。
    const normalized = header.map((h) => opts.aliases?.[h.trim()] ?? h.trim());
    const missing = opts.expectedHeader.filter((c) => !normalized.includes(c));
    if (missing.length) {
      issues.push({ line: 1, message: `缺少必需列: ${missing.join(', ')}` });
    }
  }

  return { header, rows, issues };
}

export interface CsvSerializeOptions {
  delimiter?: string;
  bom?: boolean;
  /** 默认 true：所有字段加引号 */
  quoteAll?: boolean;
  lineEnding?: '\r\n' | '\n';
}

export function escapeCsvField(value: string, delimiter: string, quoteAll: boolean): string {
  // 空字段绝不能加引号：CSV 里 "" 与「空单元格」在语义上是不同的东西，
  // 而我们用「空单元格」表示「不修改该字段」。一旦给它加上引号，
  // 数据库里的 NULL 往返一圈就会变成空字符串 —— 数据被静默改写。
  if (value === '') return '';

  const needsQuote =
    quoteAll ||
    value.includes('"') ||
    value.includes(delimiter) ||
    value.includes('\n') ||
    value.includes('\r');
  if (!needsQuote) return value;
  return '"' + value.replace(/"/g, '""') + '"';
}

export function serializeCsv(
  header: string[],
  rows: (string | number | boolean | null | undefined)[][],
  opts: CsvSerializeOptions = {},
): string {
  const delimiter = opts.delimiter ?? ',';
  const eol = opts.lineEnding ?? '\r\n';
  const quoteAll = opts.quoteAll ?? true;

  const lines: string[] = [];
  lines.push(header.map((h) => escapeCsvField(h, delimiter, quoteAll)).join(delimiter));
  for (const row of rows) {
    lines.push(
      row
        .map((v) => escapeCsvField(v === null || v === undefined ? '' : String(v), delimiter, quoteAll))
        .join(delimiter),
    );
  }
  const body = lines.join(eol) + eol;
  return (opts.bom ?? true) ? BOM + body : body;
}

// ─────────────────────────────────────────────────────────────
// 单元格 ↔ 值 的转换（纯字符串模型）
// ─────────────────────────────────────────────────────────────

/**
 * \N：兼容用的「显式空值」哨兵。**只读不写**——导出永远是空单元格。
 * 保留它是因为手工编辑过的 CSV 里可能出现，解析时应当当空值处理。
 */
export const NULL_LITERAL = '\\N';

export function isNullLiteral(v: string): boolean {
  return v === NULL_LITERAL;
}

export function toNullable(v: string | undefined): string | null {
  if (v === undefined) return null;
  if (v === '') return null;
  if (isNullLiteral(v)) return null;
  return v;
}

// ─────────────────────────────────────────────────────────────
// CSV 单元格 ↔ 我们的字符串模型
// ─────────────────────────────────────────────────────────────

/**
 * 解析 CSV 单元格。
 *
 * 「空」与「未提供」必须区分，否则导入会静默吞掉数据：
 *   缺失列 / 空字符串  → null，语义 = 不修改该字段
 *   \N                → ''  ，语义 = 显式清空该字段
 */
export function cellToRaw(v: string | undefined): string | null {
  if (v === undefined) return null;
  const t = v.trim();
  // 空单元格、\N 兼容哨兵、以及只有空白的单元格，一律归一为「空值」。
  // 归一动作必须在这里做一次，否则空串会一路渗到数据库里，
  // 变成与 NULL 不同的东西 —— 那样往返就不再是恒等变换了。
  if (t === '' || t === NULL_LITERAL) return null;
  return t;
}

/**
 * 值 → CSV 单元格。
 *
 * 关键决定：**空值一律写成空单元格，绝不写 `\N`**。
 *
 * 原因：CSV 里只有「空单元格」这一种表示空的手段，所以 `NULL` 与空字符串
 * 在导出时本来就会塌缩到一起，写哨兵并不能让信息守恒，反而让导出文件
 * 充满 `\N` 噪音、在 Excel 里也难看。
 *
 * 而且我们的语义使哨兵没有必要：导入永远是**新建工作区**，每一行都会被
 * 完整物化，不存在「部分更新」场景 —— 所以「空单元格 = 空值」是正确解读。
 * `\N` 仍被解析（见 cellToRaw），用于兼容手工编辑过的文件。
 */
export function rawToCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

/**
 * 时间轴的格子。
 *
 * **界面与命令行共用这一份**。早先 main.ts 和 cli/main.ts 各写了一份
 * `buildSlots`，于是同一件事有两个答案：界面按天、命令行按月，
 * 改了一处另一处不动。这个仓库已经在"内部标识生成"上栽过一次同样的跟头，
 * 所以这次直接抽到 core。
 *
 * 范围与粒度都是固定的，不再有参数 —— 需求就是这么定的：
 * 固定按天，覆盖「上周一 ~ 下下周日」（当前周 + 过去一周 + 未来两周）。
 */

/** 时间轴上的一格 */
export interface TimelineSlot {
  /** 起点（含），YYYY-MM-DD */
  start: string;
  /** 终点（含）。按天时等于 start */
  end: string;
  /** 横轴上的标注。空串表示这一格不写字（格线照画） */
  label: string;
  /** 是不是今天 */
  current: boolean;
  /**
   * 是不是某一周的第一天（周一）。
   *
   * 单独一个字段，**不并进 labelKind** —— 今天恰好是周一时，
   * 那一格既是"今天"又是"这周的开始"，两件事都得成立。
   * 用一个 labelKind 表达会丢掉一半，而"每周开始"正是需求点名要标的。
   */
  weekStart: boolean;
  /** 标注种类，渲染层据此上色。今天优先于周，避免今天被当成普通周一 */
  labelKind?: 'today' | 'week' | 'month';
}

/** 本地日期 → YYYY-MM-DD（不用 toISOString，那是 UTC，会差一天） */
function isoOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** 那一周的周一（周一到周日算一周） */
function mondayOf(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

/** 范围：前 1 周 + 当前周 + 后 2 周 = 4 周 28 天 */
export const TIMELINE_WEEKS_BACK = 1;
export const TIMELINE_WEEKS_AHEAD = 2;

/**
 * 生成时间轴的全部格子。**固定天粒度**。
 *
 * 起点取**上周一**而不是"今天减 7 天"：这样横轴永远从整周开始，
 * 四周的边界都落在周一/周日上，看和数都更自然。
 *
 * ── 标注规则 ──
 * 只标三种日子，其余留白：
 *   1. 今天
 *   2. 某一周的开始（周一）
 *   3. 每个月的第一天 —— 只标周的话，横轴跨月时看不出换月了
 *
 * **不标周末**：一周的结束紧邻下一周的开始，两个日期挨着标只会挤在一起，
 * 而"这周到哪天"从"下个周一是哪天"就能推出来。
 * 所以相邻周的衔接处**只留下一周的开始**。
 */
export function buildTimelineSlots(now: Date = new Date()): TimelineSlot[] {
  const todayStr = isoOf(now);
  const start = mondayOf(now);
  start.setDate(start.getDate() - TIMELINE_WEEKS_BACK * 7);

  const total = (TIMELINE_WEEKS_BACK + 1 + TIMELINE_WEEKS_AHEAD) * 7;
  const slots: TimelineSlot[] = [];

  for (let i = 0; i < total; i += 1) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const s = isoOf(d);
    const isToday = s === todayStr;
    const isWeekStart = i === 0 || d.getDay() === 1;

    let label = '';
    let labelKind: TimelineSlot['labelKind'];
    if (isToday) {
      label = `今天 ${s.slice(5)}`;
      labelKind = 'today';
    } else if (isWeekStart) {
      label = s.slice(5);
      labelKind = 'week';
    } else if (d.getDate() === 1) {
      label = s.slice(5);
      labelKind = 'month';
    }

    slots.push({ start: s, end: s, label, current: isToday, weekStart: isWeekStart, labelKind });
  }

  return slots;
}

/** 某个日期落在第几格；不在范围内给 -1 */
export function slotIndexOf(date: string, slots: TimelineSlot[]): number {
  for (let i = 0; i < slots.length; i += 1) {
    const s = slots[i]!;
    if (date >= s.start && date <= s.end) return i;
  }
  return -1;
}

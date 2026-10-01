/**
 * 零依赖参数解析。
 *
 * 刻意不引 commander/yargs：CLI 需要在「只有 Electron、没有 node_modules 的机器」上
 * 也能跑，任何外部依赖都会破坏这个性质。
 *
 * 支持的写法：
 *   --name value        --name=value        --flag
 *   --flag=true/false   -n value            --（其后全部按位置参数处理）
 *   位置参数按 commands 配置文件里的 positionals 顺序绑定
 */

export class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgError';
  }
}

export interface ParsedArgs {
  _: string[];
  [key: string]: string | number | boolean | string[];
}

export interface OptionSpec {
  name: string;
  /** 短名，如 'n' 对应 -n */
  short?: string;
  type: 'string' | 'boolean' | 'number';
  multiple?: boolean;
  default?: string | boolean | number;
  desc: string;
  valueName?: string;
}

/** 把 --foo-bar / --fooBar 归一为 fooBar */
function camelize(raw: string): string {
  return raw.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export function parseArgv(argv: string[], specs: OptionSpec[]): ParsedArgs {
  const byLong = new Map<string, OptionSpec>();
  const byShort = new Map<string, OptionSpec>();
  for (const s of specs) {
    byLong.set(s.name, s);
    byLong.set(camelize(s.name), s);
    if (s.short) byShort.set(s.short, s);
  }

  const out: ParsedArgs = { _: [] };
  for (const s of specs) {
    if (s.default !== undefined) out[s.name] = s.default;
    else if (s.type === 'boolean') out[s.name] = false;
  }

  let positionalOnly = false;
  let i = 0;

  const setValue = (spec: OptionSpec, rawValue: string | boolean): void => {
    let value: string | boolean | number = rawValue;
    if (spec.type === 'number') {
      const n = Number(rawValue);
      if (!Number.isFinite(n)) throw new ArgError(`选项 --${spec.name} 需要一个数字，实际为 "${String(rawValue)}"`);
      value = n;
    }
    if (spec.type === 'boolean' && typeof rawValue === 'string') {
      const t = rawValue.trim().toLowerCase();
      if (['true', '1', 'yes', 'y'].includes(t)) value = true;
      else if (['false', '0', 'no', 'n'].includes(t)) value = false;
      else throw new ArgError(`选项 --${spec.name} 需要 true/false，实际为 "${rawValue}"`);
    }
    if (spec.multiple) {
      const cur = out[spec.name];
      const arr = Array.isArray(cur) ? cur : cur === undefined || cur === false ? [] : [String(cur)];
      arr.push(String(value));
      out[spec.name] = arr;
    } else {
      out[spec.name] = value;
    }
  };

  while (i < argv.length) {
    const arg = argv[i]!;

    if (positionalOnly) {
      out._.push(arg);
      i += 1;
      continue;
    }
    if (arg === '--') {
      positionalOnly = true;
      i += 1;
      continue;
    }

    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const rawName = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      const spec = byLong.get(rawName) ?? byLong.get(camelize(rawName));
      if (!spec) throw new ArgError(`未知选项: --${rawName}`);

      if (eq >= 0) {
        setValue(spec, arg.slice(eq + 1));
        i += 1;
        continue;
      }
      if (spec.type === 'boolean') {
        // 支持 --flag false 与 --flag=false 两种写法
        const next = argv[i + 1];
        if (next !== undefined && /^(true|false|1|0|yes|no|y|n)$/i.test(next)) {
          setValue(spec, next);
          i += 2;
          continue;
        }
        setValue(spec, true);
        i += 1;
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('-') && next !== '-')) {
        throw new ArgError(`选项 --${spec.name} 缺少取值`);
      }
      setValue(spec, next);
      i += 2;
      continue;
    }

    if (arg.startsWith('-') && arg.length > 1 && arg !== '-') {
      const short = arg.slice(1);
      const spec = byShort.get(short);
      if (!spec) throw new ArgError(`未知选项: -${short}`);
      if (spec.type === 'boolean') {
        setValue(spec, true);
        i += 1;
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined) throw new ArgError(`选项 -${short} 缺少取值`);
      setValue(spec, next);
      i += 2;
      continue;
    }

    out._.push(arg);
    i += 1;
  }

  return out;
}

export function str(args: ParsedArgs, name: string): string | undefined {
  const v = args[name];
  if (v === undefined || v === false) return undefined;
  if (Array.isArray(v)) return v[v.length - 1];
  return String(v);
}

export function bool(args: ParsedArgs, name: string): boolean {
  const v = args[name];
  if (Array.isArray(v)) return v.length > 0;
  return v === true;
}

export function num(args: ParsedArgs, name: string): number | undefined {
  const v = str(args, name);
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function arr(args: ParsedArgs, name: string): string[] {
  const v = args[name];
  if (v === undefined || v === false) return [];
  if (Array.isArray(v)) return v.map(String);
  return [String(v)];
}

export function requireStr(args: ParsedArgs, name: string, usage: string): string {
  const v = str(args, name);
  if (v === undefined || v === '') throw new ArgError(`缺少必填参数 ${usage}`);
  return v;
}

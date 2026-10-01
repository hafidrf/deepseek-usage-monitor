// Parser for the DeepSeek platform usage endpoints (internal, unofficial).
//
// Shape verified by probing the live API on 2026-10-01:
//   amount: data.biz_data.series[].buckets[] = { time, usage: { RESPONSE_TOKEN,
//           REQUEST, PROMPT_CACHE_HIT_TOKEN, PROMPT_CACHE_MISS_TOKEN } }
//   cost  : data.biz_data.data[].series[].buckets[] = { time, cost }   (cost is a string)
//
// `biz_data.bucket = 3600`, so each bucket covers exactly one hour and the
// hourly breakdown needs no extra request.
//
// Values arrive as either strings or numbers, so everything goes through
// `Number()`. The parser is defensive by design: an unrecognised shape yields
// `null` instead of throwing, so the balance feature keeps working.

export const DAY_SECONDS = 86400;

/** Usage of a single model within a single hour. */
export interface ModelUsage {
  model: string;
  cost?: number;
  requests?: number;
  tokens?: number;
}

export interface HourBucket {
  hour: string; // "00".."23" in the user's timezone
  cost: number;
  models: ModelUsage[]; // sorted by cost, descending
}

export interface UsageData {
  date: string; // reported date, yyyy-mm-dd in the user's timezone
  cost?: number; // undefined = not available
  requests?: number;
  tokens?: number;
  hourly: HourBucket[]; // only hours that saw activity
}

export interface UsageRaw {
  amount: unknown | null;
  cost: unknown | null;
}

/**
 * Rebuild a `UsageData` read from the `globalState` cache, which may have been
 * written by an older version.
 *
 * This is not paranoia: cache written by v0.6.0 has no `hourly[].models`, and
 * rendering it directly made `modelCell` throw a TypeError, which aborted
 * `activate()` and permanently stopped polling. Unknown shapes are normalised
 * here rather than trusted.
 */
export function normalizeUsage(raw: unknown): UsageData | null {
  const r: any = raw;
  if (!r || typeof r !== 'object' || !Array.isArray(r.hourly)) return null;

  const hourly: HourBucket[] = [];
  for (const h of r.hourly) {
    if (!h || typeof h !== 'object') continue;
    hourly.push({
      hour: String(h.hour ?? '00'),
      cost: num(h.cost) ?? 0,
      models: Array.isArray(h.models)
        ? h.models
            .filter((m: any) => m && typeof m === 'object' && typeof m.model === 'string')
            .map((m: any) => ({
              model: String(m.model),
              cost: num(m.cost),
              requests: num(m.requests),
              tokens: num(m.tokens),
            }))
        : [], // older cache: no per-model information available
    });
  }

  return {
    date: String(r.date ?? ''),
    cost: num(r.cost),
    requests: num(r.requests),
    tokens: num(r.tokens),
    hourly,
  };
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Response skeleton: field NAMES and types only, never values.
 * Keys longer than 20 characters (ids, hashes) are masked. Safe to log.
 */
export function shapeOf(v: unknown, depth = 4): string {
  if (Array.isArray(v)) return v.length === 0 ? '[]' : `[${shapeOf(v[0], depth - 1)}]`;
  if (v === null) return 'null';
  if (typeof v !== 'object') return typeof v;
  if (depth <= 0) return '{...}';
  const keys = Object.keys(v as object)
    .slice(0, 14)
    .map((k) => (k.length > 20 ? '<id>' : k));
  return `{${keys.join(',')}}`;
}

/** Current date plus year/month, expressed in the user's timezone. */
export function datePartsInTz(
  tz: string,
  now: Date = new Date()
): { date: string; year: number; month: number } {
  try {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
    return {
      date: `${g('year')}-${g('month')}-${g('day')}`,
      year: Number(g('year')),
      month: Number(g('month')),
    };
  } catch {
    const iso = now.toISOString();
    return { date: iso.slice(0, 10), year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)) };
  }
}

/**
 * Timezone offset in seconds (positive = east of UTC). Asia/Jakarta -> +25200.
 *
 * Why not simply `Date.UTC(parts) - at.getTime()`: `getTime()` carries
 * milliseconds while `Date.UTC()` is second-precision, so the difference can be
 * 25199.001, and `Math.round()` turns that into 25199 — a one second shift
 * whenever the millisecond part exceeds 500. That shifted the request window,
 * the API answered with empty buckets, and usage came back `null` at random.
 *
 * The primary path below reads the offset name straight from ICU, so there is
 * no millisecond arithmetic at all.
 */
export function tzOffsetSeconds(tz: string, at: Date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'longOffset',
    }).formatToParts(at);
    const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
    if (m) {
      const sign = m[1] === '-' ? -1 : 1;
      return sign * (Number(m[2]) * 3600 + Number(m[3] ?? 0) * 60);
    }
  } catch {
    /* fall through to manual arithmetic below */
  }

  try {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(at);
    const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
    const asUtc = Date.UTC(
      g('year'),
      g('month') - 1,
      g('day'),
      g('hour') % 24,
      g('minute'),
      g('second')
    );
    // Drop milliseconds from BOTH sides so the difference is whole seconds.
    return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 1000);
  } catch {
    return -at.getTimezoneOffset() * 60;
  }
}

/**
 * Unix-second window for TODAY in the user's timezone (local 00:00 for 24
 * hours), plus the `tz` value the platform expects: `getTimezoneOffset() * 60`
 * negated, so GMT+7 -> -25200. This reproduces the URL the /usage page itself
 * sends.
 */
export function todayWindow(
  tz: string,
  now: Date = new Date()
): { start: number; end: number; tz: number } {
  const off = tzOffsetSeconds(tz, now);
  const [y, m, d] = datePartsInTz(tz, now).date.split('-').map(Number);
  const start = Math.floor((Date.UTC(y, m - 1, d) - off * 1000) / 1000);
  return { start, end: start + DAY_SECONDS, tz: -off };
}

/**
 * Collect the series list from a platform response while keeping the model name.
 *   amount: data.biz_data.series[]
 *   cost  : data.biz_data.data[].series[]   (data[] is grouped by currency)
 */
function seriesOf(raw: unknown): any[] {
  const r: any = raw;
  const d = r?.data ?? r;
  const biz = d?.biz_data ?? d;
  const groups = Array.isArray(biz?.series) ? [biz] : Array.isArray(biz?.data) ? biz.data : [];
  const out: any[] = [];
  for (const g of groups) {
    for (const s of Array.isArray(g?.series) ? g.series : []) out.push(s);
  }
  return out;
}

interface Cell {
  cost: number;
  requests: number;
  tokens: number;
}

/**
 * Fill `time -> model -> Cell`. Buckets are hourly (`bucket = 3600`), so one
 * bucket is one hour; should DeepSeek ever use a finer bucket, several buckets
 * would land in the same hour and are summed automatically.
 */
function collectBuckets(
  raw: unknown,
  metric: 'usage' | 'cost',
  into: Map<number, Map<string, Cell>>
): void {
  for (const s of seriesOf(raw)) {
    const model = String(s?.model ?? '(unnamed model)');

    for (const b of Array.isArray(s?.buckets) ? s.buckets : []) {
      const time = num(b?.time);
      if (time === undefined) continue;

      let byModel = into.get(time);
      if (!byModel) {
        byModel = new Map<string, Cell>();
        into.set(time, byModel);
      }
      let cell = byModel.get(model);
      if (!cell) {
        cell = { cost: 0, requests: 0, tokens: 0 };
        byModel.set(model, cell);
      }

      if (metric === 'cost') {
        const c = num(b?.cost);
        if (c !== undefined) cell.cost += c;
        continue;
      }

      const u = b?.usage;
      if (!u || typeof u !== 'object') continue;
      for (const [k, v] of Object.entries(u)) {
        const n = num(v);
        if (n === undefined) continue;
        const key = k.toUpperCase();
        if (key === 'REQUEST') cell.requests += n;
        else if (key.includes('TOKEN')) cell.tokens += n; // PROMPT_*, CACHE_*, RESPONSE_*
      }
    }
  }
}

/** Hour ("00".."23") in the user's timezone for a unix timestamp. */
export function hourInTz(tz: string, unixSeconds: number): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(unixSeconds * 1000));
  } catch {
    return String(new Date(unixSeconds * 1000).getUTCHours()).padStart(2, '0');
  }
}

/** Parse (amount + cost) into `UsageData`, or `null` if the shape is unknown. */
export function parseUsage(raw: UsageRaw, tz: string): UsageData | null {
  const byHour = new Map<number, Map<string, Cell>>();
  collectBuckets(raw?.cost, 'cost', byHour);
  collectBuckets(raw?.amount, 'usage', byHour);
  if (byHour.size === 0) return null;

  let requests = 0;
  let tokens = 0;
  let cost = 0;
  let anyUsage = false;
  let anyCost = false;
  const hourly: HourBucket[] = [];

  for (const [time, byModel] of [...byHour.entries()].sort((a, b) => a[0] - b[0])) {
    let hourCost = 0;
    const models: ModelUsage[] = [];

    for (const [model, cell] of byModel) {
      hourCost += cell.cost;
      cost += cell.cost;
      requests += cell.requests;
      tokens += cell.tokens;
      if (cell.cost > 0) anyCost = true;
      if (cell.requests > 0 || cell.tokens > 0) anyUsage = true;

      const active = cell.cost > 0 || cell.requests > 0 || cell.tokens > 0;
      if (!active) continue;
      models.push({
        model,
        cost: cell.cost > 0 ? cell.cost : undefined,
        requests: cell.requests > 0 ? cell.requests : undefined,
        tokens: cell.tokens > 0 ? cell.tokens : undefined,
      });
    }

    if (models.length === 0) continue; // hour with no activity at all
    models.sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));
    hourly.push({ hour: hourInTz(tz, time), cost: hourCost, models });
  }

  if (!anyUsage && !anyCost) return null;

  return {
    date: datePartsInTz(tz).date,
    cost: anyCost ? cost : undefined,
    requests: anyUsage ? requests : undefined,
    tokens: anyUsage ? tokens : undefined,
    hourly,
  };
}

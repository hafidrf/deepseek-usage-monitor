// Self-check that runs without the VS Code runtime: `npm run selfcheck`.
//
// `statusBar.ts` imports `vscode`, so it cannot be loaded here. Everything that
// is pure — the parser, the cache normaliser, the timezone helpers and the
// response-shape reporting — is covered below.

import * as assert from 'assert';
import {
  parseUsage,
  normalizeUsage,
  datePartsInTz,
  hourInTz,
  todayWindow,
  tzOffsetSeconds,
  shapeOf,
} from './usageParser';
import { ClientError } from './deepseekClient';

// 2026-10-01 00:00 GMT+7 — the real value observed in the platform's own request.
const START = 1790787600;

// Response shapes exactly as verified by probing the live API.
const amountRaw = (series: any[]) => ({
  code: 0,
  msg: '',
  data: { biz_code: 0, biz_data: { bucket: 3600, series } },
});
const costRaw = (series: any[]) => ({
  code: 0,
  msg: '',
  data: {
    biz_code: 0,
    biz_data: { bucket: 3600, data: [{ currency: 'USD', series }] },
  },
});

// 1. Hourly buckets, `usage` is an object of {TYPE: number}, two models.
const amount = amountRaw([
  {
    model: 'deepseek-v4-flash',
    buckets: [
      {
        time: START,
        usage: {
          PROMPT_CACHE_HIT_TOKEN: 40000000,
          PROMPT_CACHE_MISS_TOKEN: 5000000,
          RESPONSE_TOKEN: 665636,
          REQUEST: 203,
        },
      },
      {
        time: START + 3600,
        usage: {
          PROMPT_CACHE_HIT_TOKEN: 0,
          PROMPT_CACHE_MISS_TOKEN: 0,
          RESPONSE_TOKEN: 0,
          REQUEST: 46,
        },
      },
    ],
  },
  {
    model: 'deepseek-v4-pro',
    buckets: [
      {
        time: START,
        usage: {
          PROMPT_CACHE_HIT_TOKEN: 0,
          PROMPT_CACHE_MISS_TOKEN: 0,
          RESPONSE_TOKEN: 0,
          REQUEST: 0,
        },
      },
      {
        time: START + 3600,
        usage: {
          PROMPT_CACHE_HIT_TOKEN: 1000,
          PROMPT_CACHE_MISS_TOKEN: 0,
          RESPONSE_TOKEN: 500,
          REQUEST: 10,
        },
      },
    ],
  },
]);
const cost = costRaw([
  {
    model: 'deepseek-v4-flash',
    buckets: [
      { time: START, cost: '0.32' },
      { time: START + 3600, cost: '0.05' },
      { time: START + 7200, cost: '0' }, // zero bucket is dropped
    ],
  },
  {
    model: 'deepseek-v4-pro',
    buckets: [
      { time: START, cost: '0' },
      { time: START + 3600, cost: '0.02' },
    ],
  },
]);

const u = parseUsage({ amount, cost }, 'Asia/Jakarta');
assert.ok(u, 'parseUsage should produce data');
assert.strictEqual(u!.date, datePartsInTz('Asia/Jakarta').date);
assert.strictEqual(u!.requests, 259);
assert.strictEqual(u!.tokens, 45_667_136);
assert.ok(Math.abs((u!.cost ?? 0) - 0.39) < 1e-9, 'cost ~ 0.39');
assert.strictEqual(u!.hourly.length, 2);

// Each hourly row carries the models used, sorted by cost, descending.
assert.strictEqual(u!.hourly[0].hour, hourInTz('Asia/Jakarta', START));
assert.deepStrictEqual(u!.hourly[0].models.map((m) => m.model), ['deepseek-v4-flash']);
assert.strictEqual(u!.hourly[0].models[0].requests, 203);
assert.ok(Math.abs(u!.hourly[0].cost - 0.32) < 1e-9);
assert.strictEqual(u!.hourly[1].hour, hourInTz('Asia/Jakarta', START + 3600));
assert.deepStrictEqual(u!.hourly[1].models.map((m) => m.model), [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
]);
assert.strictEqual(u!.hourly[1].models[1].tokens, 1500);
assert.strictEqual(u!.hourly[1].models[1].cost, 0.02);

// 2. Cost only (amount request failed) still yields something displayable.
const onlyCost = parseUsage({ amount: null, cost }, 'Asia/Jakarta');
assert.ok(onlyCost);
assert.ok(Math.abs((onlyCost!.cost ?? 0) - 0.39) < 1e-9);
assert.strictEqual(onlyCost!.requests, undefined);
assert.strictEqual(onlyCost!.hourly[0].models[0].model, 'deepseek-v4-flash');

// 3. Unrecognised shapes yield null ("unavailable") instead of throwing.
assert.strictEqual(parseUsage({ amount: { foo: 1 }, cost: null }, 'Asia/Jakarta'), null);
assert.strictEqual(parseUsage({ amount: null, cost: null }, 'Asia/Jakarta'), null);
assert.strictEqual(parseUsage({ amount: amountRaw([]), cost: costRaw([]) }, 'Asia/Jakarta'), null);

// 4. The daily window must match the URL the platform's own /usage page sends.
const w = todayWindow('Asia/Jakarta', new Date('2026-10-01T02:00:00Z'));
assert.strictEqual(w.start, START);
assert.strictEqual(w.end, START + 86400);
assert.strictEqual(w.tz, -25200);
assert.strictEqual(tzOffsetSeconds('Asia/Jakarta', new Date('2026-10-01T02:00:00Z')), 25200);

// 4b. Regression: a millisecond part above 500 once shifted the offset by one
//     second, which made the window miss and the API return empty buckets.
for (const ms of [0, 1, 499, 500, 501, 999]) {
  const at = new Date(Date.UTC(2026, 9, 1, 2, 0, 0, ms));
  assert.strictEqual(tzOffsetSeconds('Asia/Jakarta', at), 25200, `offset with ms=${ms}`);
  assert.strictEqual(todayWindow('Asia/Jakarta', at).start, START, `start with ms=${ms}`);
  assert.strictEqual(todayWindow('Asia/Jakarta', at).end, START + 86400, `end with ms=${ms}`);
  assert.strictEqual(todayWindow('Asia/Jakarta', at).tz, -25200, `tz with ms=${ms}`);
}

// 5. ClientError carries a code, never a response body.
assert.strictEqual(new ClientError('auth', 'unauthorized').code, 'auth');

// 6. Regression: a cache written by an older schema must not blow up.
const stale = normalizeUsage({
  date: '2026-10-01',
  cost: 0.54,
  requests: 289,
  tokens: 56_393_681,
  hourly: [{ hour: '16', cost: 0.19 }], // v0.6.0 shape — no `models`
});
assert.ok(stale, 'an older cache payload should still be renderable');
assert.deepStrictEqual(stale!.hourly[0].models, [], 'models defaults to an empty array');
assert.strictEqual(stale!.hourly[0].hour, '16');
assert.strictEqual(stale!.cost, 0.54);
assert.strictEqual(normalizeUsage(null), null);
assert.strictEqual(normalizeUsage({ hourly: 'not an array' }), null);
assert.strictEqual(normalizeUsage({ hourly: [null, 42] })!.hourly.length, 0);
const partial = normalizeUsage({
  hourly: [{ hour: '1', cost: 1, models: [{ model: 'a' }, {}, null] }],
});
assert.deepStrictEqual(partial!.hourly[0].models, [
  { model: 'a', cost: undefined, requests: undefined, tokens: undefined },
]);

// 7. shapeOf reports field names only: never values, and long keys are masked.
assert.strictEqual(shapeOf({ code: 0, data: { biz_data: { series: [] } } }), '{code,data}');
assert.strictEqual(shapeOf({ a: 'aaaaaaaaaaaaaaaaaaaaaaaaaa' }), '{a}');
assert.strictEqual(shapeOf({ ['a'.repeat(26)]: 1 }), '{<id>}');
assert.strictEqual(shapeOf('top-secret'), 'string');
assert.strictEqual(shapeOf(null), 'null');

console.log('selfcheck OK');

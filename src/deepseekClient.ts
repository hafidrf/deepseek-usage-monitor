import * as https from 'https';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BalanceInfo {
  currency: string; // 'CNY' | 'USD'
  totalBalance: number;
  grantedBalance: number;
  toppedUpBalance: number;
}

export interface BalanceData {
  isAvailable: boolean;
  infos: BalanceInfo[];
}

export type ClientErrorCode = 'auth' | 'network' | 'rate' | 'server' | 'http' | 'parse';

export class ClientError extends Error {
  constructor(public code: ClientErrorCode, message: string) {
    super(message);
    this.name = 'ClientError';
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Only these hosts may ever be contacted. No telemetry, no third parties.
const ALLOWED_HOSTS = new Set(['api.deepseek.com', 'platform.deepseek.com']);
const OFFICIAL_BALANCE_URL = 'https://api.deepseek.com/user/balance';
const PLATFORM_BASE = 'https://platform.deepseek.com';

const TIMEOUT_MS = 10_000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

// ---------------------------------------------------------------------------
// Diagnostics hook
// ---------------------------------------------------------------------------

// Called only with text that is already safe to display: never credentials,
// never response values. Wired to the output channel by the extension.
let note: (msg: string) => void = () => {};

export function setClientLogger(fn: (msg: string) => void): void {
  note = fn;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

// node:https rather than fetch, so the host allow-list is enforced in exactly
// one place and no extra HTTP dependency is needed.
function get(
  url: string,
  headers: Record<string, string>
): Promise<{ status: number; body: string }> {
  const u = new URL(url);
  if (!ALLOWED_HOSTS.has(u.hostname)) {
    return Promise.reject(new ClientError('network', `host not allowed: ${u.hostname}`));
  }
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: 'GET',
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: { Accept: 'application/json', ...headers },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on('timeout', () => req.destroy(new ClientError('network', 'request timed out')));
    req.on('error', (e) =>
      reject(e instanceof ClientError ? e : new ClientError('network', 'connection failed'))
    );
    req.end();
  });
}

async function getWithRetry(
  url: string,
  headers: Record<string, string>,
  attempts = 3
): Promise<{ status: number; body: string }> {
  let last: ClientError | undefined;

  for (let i = 0; i < attempts; i++) {
    try {
      const res = await get(url, headers);

      if (res.status === 401 || res.status === 403) {
        // Deliberately generic: the response body is never read or logged, so a
        // rejected credential cannot leak into the output channel.
        throw new ClientError('auth', 'unauthorized');
      }
      if (RETRYABLE_STATUS.has(res.status)) {
        last = new ClientError(res.status === 429 ? 'rate' : 'server', `HTTP ${res.status}`);
      } else if (res.status >= 400) {
        // Any other 4xx will not improve by retrying, so fail immediately.
        throw new ClientError('http', `HTTP ${res.status}`);
      } else {
        return res;
      }
    } catch (e) {
      if (e instanceof ClientError && (e.code === 'auth' || e.code === 'http')) throw e;
      last = e instanceof ClientError ? e : new ClientError('network', 'connection failed');
      note(`GET ${new URL(url).pathname} -> ${last.code} (attempt ${i + 1}/${attempts})`);
    }

    await new Promise((r) => setTimeout(r, 1000 * Math.pow(3, i))); // backoff: 1s, 3s
  }

  throw last ?? new ClientError('network', 'connection failed');
}

async function getJson(url: string, headers: Record<string, string>): Promise<any> {
  const res = await getWithRetry(url, headers);
  try {
    return JSON.parse(res.body);
  } catch {
    throw new ClientError('parse', 'response is not JSON');
  }
}

// ---------------------------------------------------------------------------
// Balance — official API
// ---------------------------------------------------------------------------

/**
 * GET https://api.deepseek.com/user/balance
 * Auth: `Authorization: Bearer sk-...` (a regular API key).
 */
export async function fetchBalance(apiKey: string): Promise<BalanceData> {
  const res = await getWithRetry(OFFICIAL_BALANCE_URL, { Authorization: `Bearer ${apiKey}` });

  let raw: any;
  try {
    raw = JSON.parse(res.body);
  } catch {
    throw new ClientError('parse', 'balance response is not JSON');
  }

  const infos: BalanceInfo[] = Array.isArray(raw?.balance_infos)
    ? raw.balance_infos.map((x: any) => ({
        currency: String(x?.currency ?? ''),
        totalBalance: Number(x?.total_balance) || 0,
        grantedBalance: Number(x?.granted_balance) || 0,
        toppedUpBalance: Number(x?.topped_up_balance) || 0,
      }))
    : [];

  if (infos.length === 0) throw new ClientError('parse', 'balance_infos is empty');
  return { isAvailable: Boolean(raw?.is_available), infos };
}

// ---------------------------------------------------------------------------
// Usage — platform endpoints (INTERNAL, UNOFFICIAL)
// ---------------------------------------------------------------------------
//
// This contract was verified by probing the live API on 2026-10-01, NOT copied
// from third-party repositories — several of those publish a different and
// incorrect shape (`data.biz_data.days[].data[].usage[]`).
//
//   GET /api/v0/usage/by_api_key/amount?start=<unix>&end=<unix>&tz=<offset>  -> 200
//   GET /api/v0/usage/by_api_key/cost?start=<unix>&end=<unix>&tz=<offset>    -> 200
//   GET /api/v0/usage/amount?month=&year=   -> 422 (a `month` query param is required)
//   GET /api/v0/usage/by_model/amount       -> 404
//
// `start` and `end` are unix SECONDS. `tz` is the negated timezone offset in
// seconds, i.e. `new Date().getTimezoneOffset() * 60` (GMT+7 -> -25200).
//
// Response shape: `data.biz_data.{series | data[].series}[].buckets[]`, with
// `biz_data.bucket = 3600`. One bucket is therefore one hour, which is why an
// hourly breakdown comes for free from the same request.
//
// Auth is a platform *session* token — the `authorization` header visible in
// DevTools while logged in — never the `sk-...` API key.
//
// These endpoints are unofficial and can change or disappear without notice.

export const AMOUNT_PATH = '/api/v0/usage/by_api_key/amount';
export const COST_PATH = '/api/v0/usage/by_api_key/cost';

export function platformHeaders(token: string, cookie?: string): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}`,
    Accept: '*/*',
    Referer: `${PLATFORM_BASE}/usage`,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    'x-client-platform': 'web',
    'x-client-version': '1.0.0',
    'x-client-locale': 'en_US',
    'x-client-bundle-id': 'com.deepseek.chat',
  };
  if (cookie && cookie.trim()) h.Cookie = cookie.trim();
  return h;
}

export interface PlatformUsageRaw {
  amount: unknown;
  cost: unknown | null;
  route: string;
}

/**
 * One day of usage: token/request counts plus cost when available.
 *
 * `amount` must succeed — auth errors are propagated so the caller can react.
 * `cost` is best effort: if that endpoint breaks, requests and tokens are still
 * displayed instead of the whole feature failing.
 */
export async function fetchPlatformUsage(
  token: string,
  start: number,
  end: number,
  tz: number,
  cookie?: string
): Promise<PlatformUsageRaw> {
  const q = `?start=${start}&end=${end}&tz=${tz}`;
  const h = platformHeaders(token, cookie);

  const amount = await getJson(`${PLATFORM_BASE}${AMOUNT_PATH}${q}`, h);
  note(`usage: amount OK (window ${start}..${end}, tz ${tz})`);

  const cost = await getJson(`${PLATFORM_BASE}${COST_PATH}${q}`, h)
    .then((r) => {
      note('usage: cost OK');
      return r as unknown;
    })
    .catch((e) => {
      note(`usage: cost failed (${e instanceof ClientError ? e.code : 'unknown'})`);
      return null;
    });

  return { amount, cost, route: AMOUNT_PATH };
}

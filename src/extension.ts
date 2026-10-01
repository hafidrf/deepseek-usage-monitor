import * as vscode from 'vscode';
import {
  BalanceData,
  ClientError,
  fetchBalance,
  fetchPlatformUsage,
  setClientLogger,
} from './deepseekClient';
import { initLog, log } from './log';
import { normalizeUsage, parseUsage, shapeOf, todayWindow } from './usageParser';
import { StatusBarController, Snapshot, UiConfig } from './statusBar';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXT_ID = 'hafidrf.deepseek-usage-monitor';

// Credentials live in SecretStorage only — never in settings.json, never in
// globalState, never in the repository.
const K_APIKEY = 'deepseekUsage.apiKey';
const K_USAGE_TOKEN = 'deepseekUsage.platformToken';
const K_COOKIE = 'deepseekUsage.cfClearance';

// The cache key carries a schema version, so a payload written by an older build
// is ignored instead of being force-read.
const K_SNAPSHOT = 'deepseekUsage.snapshot.v2';

// Pause polling after this long without window focus. Manual refresh still works.
const UNFOCUSED_PAUSE_MS = 10 * 60_000;

let EXT_VERSION = 'dev';
let controller: StatusBarController | undefined;
let timer: NodeJS.Timeout | undefined;
let unfocusedSince: number | undefined;
let pollInFlight = false;

function readConfig(): UiConfig & { interval: number } {
  const c = vscode.workspace.getConfiguration('deepseekUsage');
  return {
    position: c.get('position', 'right') as 'left' | 'right',
    textFormat: c.get('textFormat', 'compact') as 'compact' | 'full',
    threshold: c.get('lowBalanceThreshold', 5),
    timezone: c.get('timezone', 'Asia/Jakarta'),
    // The platform lags up to 5 minutes, so polling faster than 30s is pointless.
    interval: Math.max(30, c.get('refreshIntervalSeconds', 60)),
    version: EXT_VERSION,
    hasApiKey: false, // filled in by the caller, which is async
  };
}

export async function activate(context: vscode.ExtensionContext) {
  const { secrets, globalState } = context;

  context.subscriptions.push(initLog());
  setClientLogger(log);
  EXT_VERSION = String(vscode.extensions.getExtension(EXT_ID)?.packageJSON?.version ?? 'dev');
  log(`activate v${EXT_VERSION}`);

  const alignmentFor = (pos: string) =>
    pos === 'left' ? vscode.StatusBarAlignment.Left : vscode.StatusBarAlignment.Right;

  // A cached snapshot may come from an older schema, so it is normalised before
  // use. Unknown shapes are dropped, never trusted: a v0.6.0 snapshot without
  // `hourly[].models` once aborted activate() and permanently killed polling.
  const cached = globalState.get<any>(K_SNAPSHOT);
  let snap: Snapshot = {
    balance:
      cached?.balance && Array.isArray(cached.balance.infos)
        ? (cached.balance as BalanceData)
        : undefined,
    usage: normalizeUsage(cached?.usage),
    usageRoute: typeof cached?.usageRoute === 'string' ? cached.usageRoute : undefined,
    updatedAt: typeof cached?.updatedAt === 'number' ? cached.updatedAt : undefined,
  };

  controller = new StatusBarController(alignmentFor(readConfig().position));

  const currentConfig = async (): Promise<UiConfig & { interval: number }> => {
    const c = readConfig();
    c.hasApiKey = Boolean(await secrets.get(K_APIKEY));
    return c;
  };

  const render = async () => controller!.render(snap, await currentConfig());

  // Only non-sensitive data (balance, usage counts) is cached — never the key or token.
  const saveSnapshot = async () => globalState.update(K_SNAPSHOT, snap);

  const poll = async (manual = false) => {
    if (pollInFlight) return;
    if (!manual && unfocusedSince && Date.now() - unfocusedSince > UNFOCUSED_PAUSE_MS) return;

    pollInFlight = true;
    try {
      const c = await currentConfig();
      const apiKey = await secrets.get(K_APIKEY);

      if (!apiKey) {
        snap.error = undefined;
        snap.offline = false;
        await render();
        return;
      }

      let refreshed = false;

      try {
        snap.balance = await fetchBalance(apiKey);
        snap.error = undefined;
        snap.offline = false;
        refreshed = true;
      } catch (e) {
        const code = e instanceof ClientError ? e.code : 'other';
        if (code === 'auth') {
          snap.error = 'auth';
        } else {
          snap.error = 'network';
          snap.offline = true; // keep showing the last cached reading
        }
      }

      // Platform usage is allowed to fail on its own without affecting the balance.
      const token = await secrets.get(K_USAGE_TOKEN);
      if (!token) {
        snap.usage = null;
        snap.usageAuthExpired = false;
      } else {
        const cookie = await secrets.get(K_COOKIE);
        const { start, end, tz: tzOffset } = todayWindow(c.timezone);
        log(
          `usage: window start=${start} end=${end} tz=${tzOffset} cookie=${cookie ? 'set' : 'none'}`
        );
        try {
          const raw = await fetchPlatformUsage(token, start, end, tzOffset, cookie);
          snap.usage = parseUsage(raw, c.timezone);
          snap.usageRoute = raw.route;
          snap.usageAuthExpired = false;
          if (snap.usage) {
            refreshed = true;
            log(
              `usage: OK date=${snap.usage.date} cost=${snap.usage.cost ?? '-'} ` +
                `req=${snap.usage.requests ?? '-'} tok=${snap.usage.tokens ?? '-'}`
            );
          } else {
            log(
              `usage: unrecognised shape — amount=${shapeOf(raw.amount)} cost=${shapeOf(raw.cost)}`
            );
          }
        } catch (e) {
          const code = e instanceof ClientError ? e.code : 'unknown';
          log(`usage: failed (${code})`);
          snap.usage = null; // falls back to "unavailable"; the balance keeps working
          snap.usageRoute = undefined;
          snap.usageAuthExpired = code === 'auth';
        }
      }

      // Stamp the time whenever anything refreshed, even if the balance call
      // failed but usage succeeded.
      if (refreshed) snap.updatedAt = Date.now();

      await saveSnapshot();
      await render();
    } finally {
      pollInFlight = false;
    }
  };

  const startTimer = async () => {
    if (timer) clearInterval(timer);
    const { interval } = await currentConfig();
    timer = setInterval(() => void poll(), interval * 1000);
  };

  // ---- Commands ----------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('deepseekUsage.refresh', () => void poll(true)),

    vscode.commands.registerCommand('deepseekUsage.setApiKey', async () => {
      const v = await vscode.window.showInputBox({
        prompt: 'DeepSeek API key (used against api.deepseek.com)',
        placeHolder: 'sk-...',
        password: true,
        ignoreFocusOut: true,
      });
      if (v && v.trim()) {
        await secrets.store(K_APIKEY, v.trim());
        snap.error = undefined;
        void poll(true);
      }
    }),

    vscode.commands.registerCommand('deepseekUsage.setToken', async () => {
      const v = await vscode.window.showInputBox({
        prompt:
          'DeepSeek platform session token (the `authorization` request header) — this is NOT the sk-... API key',
        placeHolder: 'DevTools → Network → request headers → authorization',
        password: true,
        ignoreFocusOut: true,
      });
      if (v !== undefined && v.trim()) {
        await secrets.store(K_USAGE_TOKEN, v.trim().replace(/^Bearer\s+/i, ''));
        void poll(true);
      }
    }),

    vscode.commands.registerCommand('deepseekUsage.setCookie', async () => {
      const v = await vscode.window.showInputBox({
        prompt:
          'Optional: paste the whole `Cookie` request header from a usage request (it contains cf_clearance). Only needed if the tooltip reports a block or 403.',
        placeHolder: 'sml_DV2=...; cf_clearance=...',
        password: true,
        ignoreFocusOut: true,
      });
      if (v !== undefined && v.trim()) {
        await secrets.store(K_COOKIE, v.trim());
        void poll(true);
      }
    }),

    vscode.commands.registerCommand('deepseekUsage.openUsagePage', () => {
      void vscode.env.openExternal(vscode.Uri.parse('https://platform.deepseek.com/usage'));
    }),

    vscode.commands.registerCommand('deepseekUsage.diagnose', async () => {
      const out = initLog();
      out.show(true);

      const apiKey = await secrets.get(K_APIKEY);
      const token = await secrets.get(K_USAGE_TOKEN);
      const cookie = await secrets.get(K_COOKIE);
      const c = await currentConfig();

      log('--- diagnostics ---');
      log(
        `version=${EXT_VERSION} apiKey=${apiKey ? 'set' : 'empty'} ` +
          `token=${token ? 'set' : 'empty'} cookie=${cookie ? 'set' : 'empty'}`
      );

      const { start, end, tz: tzOffset } = todayWindow(c.timezone);
      log(`window start=${start} end=${end} tz=${tzOffset}`);

      if (apiKey) {
        try {
          const b = await fetchBalance(apiKey);
          log(
            `balance OK: ${b.infos
              .map((i) => `${i.currency} total=${i.totalBalance} toppedUp=${i.toppedUpBalance}`)
              .join(' | ')}`
          );
        } catch (e) {
          log(`balance FAILED: ${e instanceof ClientError ? e.code : 'unknown'}`);
        }
      } else {
        log('balance skipped: no API key set');
      }

      if (token) {
        try {
          const raw = await fetchPlatformUsage(token, start, end, tzOffset, cookie);
          log(`usage OK via ${raw.route}`);
          log(`shape amount: ${shapeOf(raw.amount)}`);
          log(`shape cost:   ${shapeOf(raw.cost)}`);
        } catch (e) {
          log(`usage FAILED: ${e instanceof ClientError ? e.code : 'unknown'}`);
        }
      } else {
        log('usage skipped: no platform token set');
      }

      void vscode.window.showInformationMessage(
        'Diagnostics finished — see Output → DeepSeek Usage Monitor.'
      );
    }),

    vscode.commands.registerCommand('deepseekUsage.quickPick', async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: '$(refresh) Refresh now', cmd: 'deepseekUsage.refresh' },
          { label: '$(key) Set API key', cmd: 'deepseekUsage.setApiKey' },
          { label: '$(shield) Set usage token', cmd: 'deepseekUsage.setToken' },
          { label: '$(globe) Set cf_clearance cookie', cmd: 'deepseekUsage.setCookie' },
          { label: '$(output) Diagnostics (open log)', cmd: 'deepseekUsage.diagnose' },
          {
            label: '$(link-external) Open the Usage page in a browser',
            cmd: 'deepseekUsage.openUsagePage',
          },
          {
            label: '$(gear) Settings',
            cmd: 'workbench.action.openSettings',
            args: 'deepseekUsage',
          },
        ],
        { placeHolder: 'DeepSeek Usage Monitor' }
      );
      if (pick) void vscode.commands.executeCommand(pick.cmd, (pick as any).args);
    })
  );

  // ---- React to settings and focus changes -------------------------------
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('deepseekUsage')) return;
      const c = await currentConfig();
      controller!.realign(alignmentFor(c.position));
      await startTimer();
      await render();
    }),

    vscode.window.onDidChangeWindowState((e) => {
      if (e.focused) {
        unfocusedSince = undefined;
        void poll(true); // refresh immediately when focus returns
      } else {
        unfocusedSince = Date.now();
      }
    }),

    { dispose: () => controller?.dispose() },
    { dispose: () => timer && clearInterval(timer) }
  );

  // Order matters: start the timer before the first render, so a rendering
  // failure can never leave the extension running without polling.
  await startTimer();
  try {
    await render(); // paint the cached snapshot immediately
  } catch (e) {
    log(`initial render failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  void poll(true);
}

export function deactivate() {
  if (timer) clearInterval(timer);
}

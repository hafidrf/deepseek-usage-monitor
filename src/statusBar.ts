import * as vscode from 'vscode';
import { BalanceData } from './deepseekClient';
import { log } from './log';
import { HourBucket, UsageData } from './usageParser';

const STATUS_BAR_PRIORITY = 1000;

export interface Snapshot {
  balance?: BalanceData;
  usage?: UsageData | null; // null = unavailable
  usageAuthExpired?: boolean;
  usageRoute?: string; // usage endpoint path that answered
  updatedAt?: number; // epoch ms
  offline?: boolean; // last cached reading is being shown
  error?: 'auth' | 'network' | 'other';
}

export interface UiConfig {
  position: 'left' | 'right';
  textFormat: 'compact' | 'full';
  threshold: number;
  timezone: string;
  hasApiKey: boolean;
  version: string;
}

/** Money formatting that keeps sub-cent amounts readable instead of "$0.00". */
export function usd(n: number): string {
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** Short "today" fragment appended to the status bar text. */
export function usageSuffix(snap: Snapshot): string {
  if (snap.usageAuthExpired) return ' | usage: token expired';
  const u = snap.usage;
  if (!u) return ' | usage: unavailable';
  if (u.cost !== undefined) return ` | today ${usd(u.cost)}`;
  if (u.tokens !== undefined) return ` | today ${u.tokens.toLocaleString('en-US')} tok`;
  return ' | usage: unavailable';
}

/** Extra fragment for the `full` text format: request and token counts. */
export function detailSuffix(u: UsageData): string {
  const parts: string[] = [];
  if (u.requests !== undefined) parts.push(`${u.requests} req`);
  if (u.tokens !== undefined) parts.push(`${u.tokens.toLocaleString('en-US')} tok`);
  return parts.length > 0 ? ` | ${parts.join(', ')}` : '';
}

/** "Model" cell of the hourly table: model name plus its cost contribution. */
function modelCell(h: HourBucket): string {
  const models = h.models ?? []; // snapshots written by older versions may lack this
  if (models.length === 0) return '—';
  return models
    .map((m) => (m.cost !== undefined ? `${m.model} (${usd(m.cost)})` : m.model))
    .join(', ');
}

/** Top-up balance in USD, falling back to the first currency's total. */
export function topUpUsd(b?: BalanceData): number | undefined {
  if (!b) return undefined;
  const usdInfo = b.infos.find((i) => i.currency === 'USD');
  if (usdInfo) return usdInfo.toppedUpBalance || usdInfo.totalBalance;
  return b.infos[0]?.totalBalance;
}

function fmtTime(ms: number, tz: string): string {
  try {
    return (
      new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        dateStyle: 'short',
        timeStyle: 'medium',
      }).format(new Date(ms)) + ` (${tz})`
    );
  } catch {
    return new Date(ms).toISOString() + ' (UTC)';
  }
}

export class StatusBarController implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private alignment: vscode.StatusBarAlignment;
  private warnedThisSession = false;

  constructor(alignment: vscode.StatusBarAlignment, private priority = STATUS_BAR_PRIORITY) {
    this.alignment = alignment;
    this.item = this.createItem();
  }

  private createItem(): vscode.StatusBarItem {
    const item = vscode.window.createStatusBarItem(this.alignment, this.priority);
    item.command = 'deepseekUsage.quickPick';
    item.show();
    return item;
  }

  /**
   * Move the item to the other side of the status bar. A no-op when the side did
   * not actually change, so editing unrelated settings does not churn the item.
   */
  realign(alignment: vscode.StatusBarAlignment): void {
    if (alignment === this.alignment) return;
    this.alignment = alignment;
    this.item.dispose();
    this.item = this.createItem();
  }

  render(snap: Snapshot, cfg: UiConfig): void {
    // State: no API key configured yet.
    if (!cfg.hasApiKey) {
      this.item.text = '$(key) DeepSeek: set API key';
      this.item.tooltip = 'Click to set your API key (kept in SecretStorage, never in settings).';
      this.item.backgroundColor = undefined;
      return;
    }

    // State: credential rejected (401/403).
    if (snap.error === 'auth') {
      this.item.text = '$(warning) DeepSeek: sign in again';
      this.item.tooltip = new vscode.MarkdownString(
        'The API key or session token was rejected (401/403). Replace it via the QuickPick → **Set API key**.'
      );
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      return;
    }

    const bal = topUpUsd(snap.balance);
    const offline = snap.offline ? ' (offline)' : '';
    const usageTxt = usageSuffix(snap);

    if (bal === undefined) {
      this.item.text =
        snap.error === 'network' ? '$(warning) DeepSeek: offline' : '$(sync) DeepSeek…';
      this.item.tooltip = new vscode.MarkdownString('Waiting for the first reading…');
      this.item.backgroundColor = undefined;
      return;
    }

    const full = cfg.textFormat === 'full' && snap.usage ? detailSuffix(snap.usage) : '';

    this.item.text = `$(pulse) ${usd(bal)}${usageTxt}${full}${offline}`;
    this.item.backgroundColor =
      bal < cfg.threshold ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;

    this.item.tooltip = this.safeTooltip(snap, cfg, bal);

    // Low balance: warn once per session rather than on every poll.
    if (bal < cfg.threshold && !this.warnedThisSession) {
      this.warnedThisSession = true;
      void vscode.window.showWarningMessage(
        `DeepSeek top-up balance ${usd(bal)} is below the ${usd(cfg.threshold)} threshold.`
      );
    }
  }

  /**
   * The tooltip must never throw. A single TypeError in here once aborted
   * `activate()` and stopped polling for the rest of the session, which looked
   * like "the balance stopped updating" rather than a rendering bug.
   */
  private safeTooltip(snap: Snapshot, cfg: UiConfig, bal: number): vscode.MarkdownString | string {
    try {
      return this.buildTooltip(snap, cfg, bal);
    } catch (e) {
      log(`tooltip render failed: ${e instanceof Error ? e.message : String(e)}`);
      return 'DeepSeek Usage Monitor — tooltip failed to render. See Output → DeepSeek Usage Monitor.';
    }
  }

  private buildTooltip(snap: Snapshot, cfg: UiConfig, bal: number): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.supportThemeIcons = true;
    md.appendMarkdown(`**DeepSeek Usage Monitor** v${cfg.version}\n\n`);
    md.appendMarkdown(`- Top-up balance: **${usd(bal)}**\n`);

    if (snap.balance) {
      for (const i of snap.balance.infos) {
        if (i.currency !== 'USD') {
          md.appendMarkdown(
            `- ${i.currency}: total ${i.totalBalance}, granted ${i.grantedBalance}\n`
          );
        }
      }
    }

    if (snap.usageAuthExpired) {
      md.appendMarkdown(
        `\n- Usage: *platform token expired* — run **Set usage token** to renew it\n`
      );
    } else if (snap.usage) {
      md.appendMarkdown(`\n**Today** (${snap.usage.date})\n`);
      if (snap.usage.cost !== undefined) {
        md.appendMarkdown(`- Cost: **${usd(snap.usage.cost)}**\n`);
      }
      if (snap.usage.requests !== undefined) {
        md.appendMarkdown(`- API requests: ${snap.usage.requests}\n`);
      }
      if (snap.usage.tokens !== undefined) {
        md.appendMarkdown(`- Total tokens: ${snap.usage.tokens.toLocaleString('en-US')}\n`);
      }
      if (Array.isArray(snap.usage.hourly) && snap.usage.hourly.length > 0) {
        md.appendMarkdown(`\n| Hour | Cost | Model |\n|---|---|---|\n`);
        for (const h of snap.usage.hourly) {
          md.appendMarkdown(`| ${h.hour}:00 | ${usd(h.cost)} | ${modelCell(h)} |\n`);
        }
      }
      if (snap.usageRoute) {
        md.appendMarkdown(`\nSource: \`${snap.usageRoute}\` — unofficial endpoint\n`);
      }
    } else {
      md.appendMarkdown(
        `\n- Usage: *unavailable* — set the platform token via the QuickPick → **Set usage token**\n`
      );
    }

    md.appendMarkdown(`\n---\n`);
    if (snap.error === 'network') {
      md.appendMarkdown(`⚠ *Offline — showing the last cached reading.*\n\n`);
    }
    md.appendMarkdown(
      `🕐 Last update: ${snap.updatedAt ? fmtTime(snap.updatedAt, cfg.timezone) : '-'}`
    );

    return md;
  }

  dispose(): void {
    this.item.dispose();
  }
}

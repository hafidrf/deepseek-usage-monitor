import * as vscode from 'vscode';

// A single output channel for diagnostics.
//
// RULE: never write an API key, a session token, or a Cookie header value here.
// Only status, error codes and response *field names* (see `shapeOf`). Balance
// amounts are fine — they are not secrets.

let channel: vscode.OutputChannel | undefined;

export function initLog(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('DeepSeek Usage Monitor');
  }
  return channel;
}

export function log(msg: string): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  (channel ?? initLog()).appendLine(`[${ts}] ${msg}`);
}

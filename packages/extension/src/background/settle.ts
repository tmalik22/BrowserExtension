/**
 * Waiting for the page to settle after an action: no main-frame load in progress, network idle
 * (ignoring long-polls/websockets), and the DOM quiet for a moment. Bounded so slow pages don't
 * stall the agent.
 */
import { isLoading, lastNetworkActivity, openDialog, pendingRequests } from './cdp.ts';
import { frameCall } from './frames.ts';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function settle(tabId: number, opts: { minMs?: number; maxMs?: number; quietMs?: number } = {}): Promise<'settled' | 'timeout' | 'dialog'> {
  const min = opts.minMs ?? 120;
  const max = opts.maxMs ?? 3000;
  const quiet = opts.quietMs ?? 250;
  const t0 = Date.now();
  await sleep(min);
  while (Date.now() - t0 < max) {
    if (openDialog(tabId)) return 'dialog';
    const idleFor = Date.now() - lastNetworkActivity(tabId);
    if (!isLoading(tabId) && pendingRequests(tabId) === 0 && idleFor >= 250) {
      // Pages with timers/animations mutate constantly: the DOM-quiet wait is short and capped;
      // network idle and load state are the stronger signals.
      const left = Math.min(800, Math.max(100, max - (Date.now() - t0)));
      try {
        await frameCall(tabId, 0, { type: 'ba:quiet', quietMs: quiet, maxMs: left }, left + 1000);
      } catch {
        /* page busy or restricted: treat as settled */
      }
      return openDialog(tabId) ? 'dialog' : 'settled';
    }
    await sleep(80);
  }
  return 'timeout';
}

/** Wait for a navigation in the tab to finish loading. */
export async function waitForLoad(tabId: number, maxMs: number): Promise<'loaded' | 'timeout' | 'dialog'> {
  const t0 = Date.now();
  // Give the navigation a moment to start.
  await sleep(150);
  while (Date.now() - t0 < maxMs) {
    if (openDialog(tabId)) return 'dialog';
    let status: string | undefined;
    try {
      status = (await chrome.tabs.get(tabId)).status;
    } catch {
      throw new Error('Error: the tab was closed during navigation.');
    }
    if (status === 'complete' && !isLoading(tabId)) return 'loaded';
    await sleep(100);
  }
  return 'timeout';
}

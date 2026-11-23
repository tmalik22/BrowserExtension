/**
 * End-to-end: things that used to go wrong while working. The agent's own "working" pill getting
 * in the way of its clicks, late-loading frames slowing every action down, "Leave site?" prompts
 * hanging navigation, and the page staying locked when the server goes away.
 */
import { test, expect } from '@playwright/test';
import type { AgentEvent } from '@ba/shared';
import { pageFor, run, script, startEnv, until, type Env } from './harness.ts';

let env: Env;

test.beforeAll(async () => {
  env = await startEnv({ permissionMode: 'auto' });
});
test.afterAll(async () => {
  await env?.close();
});

const ref = (c: { mustRef(role: string, name: string | RegExp): string }, role: string, name: string | RegExp) => ({ type: 'ref', ref: c.mustRef(role, name) });

/** How long each tool call took, from the events of a run. */
function timer() {
  const started = new Map<string, number>();
  const took: { member: string; ms: number }[] = [];
  const members = new Map<string, string>();
  return {
    onEvent(e: AgentEvent) {
      if (e.type === 'tool_call') {
        started.set(e.callId, Date.now());
        members.set(e.callId, e.member);
      } else if (e.type === 'tool_result' && started.has(e.callId)) {
        took.push({ member: members.get(e.callId)!, ms: Date.now() - started.get(e.callId)! });
      }
    },
    of: (member: string) => took.filter((t) => t.member === member).map((t) => t.ms),
  };
}

test("the agent's own status pill does not get in the way of its clicks", async () => {
  // By reference: the control sits right under the pill.
  const byRef = await run(env, script([() => [{ name: 'find', input: { query: 'search everything' } }], (c) => [{ name: 'left_click', input: { target: ref(c, 'button', 'Search everything') } }], () => 'done']), {
    startUrl: env.fx.url('pill-target.html'),
  });
  expect(byRef.results[1].result.isError, byRef.text(1)).toBe(false);
  const page = await pageFor(env, 'pill-target.html');
  await expect(page.locator('#under')).toHaveText('HIT 1');

  // By coordinate, from a screenshot (where the pill isn't shown): the middle of the control.
  const box = (await page.locator('#under').boundingBox())!;
  const inner = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  const byPoint = await run(
    env,
    script([
      () => [{ name: 'screenshot' }],
      (c) => {
        const img = c.last[0].result.content.find((b) => b.type === 'image') as { width: number; height: number };
        const x = Math.round((box.x + box.width / 2) * (img.width / inner.w));
        const y = Math.round((box.y + box.height / 2) * (img.height / inner.h));
        return [{ name: 'left_click', input: { target: { type: 'coordinate', x, y } } }];
      },
      () => 'done',
    ]),
    { sessionId: byRef.sessionId },
  );
  // It hit the page's control (and says so), not the pill, and did not press its own Stop.
  expect(byPoint.text(1)).toMatch(/on button "HIT 1"/); // the control's label after the first click
  expect(byPoint.reason).toBe('end_turn');
  await expect(page.locator('#under')).toHaveText('HIT 2');
});

test('a frame that loads after the page does not make every later action wait', async () => {
  const t = timer();
  const s = script([
    // Give the late frame time to be added and to load.
    () => [{ name: 'wait', input: { duration: 2 } }],
    () => [{ name: 'find', input: { query: 'press me' } }],
    (c) => [{ name: 'left_click', input: { target: ref(c, 'button', 'Press me') } }],
    () => 'done',
  ]);
  const r = await run(env, s, { startUrl: env.fx.url('late-frame.html'), onEvent: t.onEvent });
  const page = await pageFor(env, 'late-frame.html');
  await expect(page.locator('#go')).toHaveText('Clicked');
  expect(page.frames().some((f) => f.url().includes('frame-nested.html'))).toBe(true);
  expect(r.text(2)).toMatch(/Clicked element/);
  // The page is idle: the click should take well under the 3-second "still loading" cap.
  expect(t.of('left_click')[0]).toBeLessThan(2000);
});

test('a "Leave site?" prompt does not hang the agent when it navigates away', async () => {
  const t = timer();
  const target = env.fx.url('article.html?after-leave');
  const s = script([
    () => [{ name: 'find', input: { query: 'draft' } }],
    (c) => [{ name: 'left_click', input: { target: ref(c, 'textbox', 'Draft') } }, { name: 'type', input: { text: 'unsaved words' } }],
    () => [{ name: 'navigate', input: { url: target } }],
    () => [{ name: 'get_page_text' }],
    () => 'done',
  ]);
  const r = await run(env, s, { startUrl: env.fx.url('leave.html'), onEvent: t.onEvent });
  expect(r.results[3].result.isError, r.text(3)).toBe(false);
  expect(r.text(3)).toMatch(/Navigated to .*after-leave/);
  expect(r.text(4)).toContain('4217');
  expect(t.of('navigate')[0]).toBeLessThan(15_000);
});

test('when the server goes away mid-task, the page is unlocked and the task marked as stopped', async () => {
  // Its own browser and server: this test shuts the server down.
  const own = await startEnv({ permissionMode: 'auto', lockUserInput: true });
  try {
    const s = script([() => [{ name: 'read_page' }], () => [{ name: 'wait', input: { duration: 25 } }], () => 'done']);
    const { sessionId, done } = own.server.startOrContinue({ text: `#script:${s}`, profileId: 'mock', startUrl: own.fx.url('lock.html'), autoApprove: 'allow_once' });
    done.catch(() => {});
    let waiting = false;
    own.server.subscribe(sessionId, (_seq, e) => {
      if (e.type === 'tool_call' && e.member === 'wait') waiting = true;
    });
    await until(() => waiting, 15_000, 'the task to be under way');
    const page = await pageFor(own, 'lock.html');
    const running = () => own.sw.evaluate((id) => (globalThis as any).__ba.allSessions().find((x: any) => x.id === id)?.running, sessionId);
    expect(await running()).toBe(true);
    await expect(page.locator('ba-agent-overlay')).toHaveCount(1);
    // While the agent works, the user's clicks in its tab are blocked.
    await page.mouse.click(...(await centre(page, '#mine')));
    await expect(page.locator('#mine')).toHaveText('My button');

    await own.server.close();

    await until(async () => (await running()) === false, 10_000, 'the extension to notice');
    // The user has their page back.
    await until(async () => {
      await page.mouse.click(...(await centre(page, '#mine')));
      return (await page.locator('#mine').textContent())!.startsWith('Mine');
    }, 5000, 'clicks to work again');
  } finally {
    await own.context.close().catch(() => {});
    await own.fx.close();
  }
});

async function centre(page: import('@playwright/test').Page, selector: string): Promise<[number, number]> {
  const b = (await page.locator(selector).boundingBox())!;
  return [b.x + b.width / 2, b.y + b.height / 2];
}

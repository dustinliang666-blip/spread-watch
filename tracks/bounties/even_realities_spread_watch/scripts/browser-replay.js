import assert from 'node:assert/strict';

// Install before navigation so even blocked network attempts fail the run.
export async function guardReplay(page, origin, paths) {
  const external = [];
  const unexpected = [];
  const pageErrors = [];
  await page.addInitScript(() => {
    window.replayPolicyViolations = [];
    window.addEventListener('securitypolicyviolation', ({ effectiveDirective }) => {
      window.replayPolicyViolations.push(effectiveDirective);
    });
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin) external.push(url.origin);
  });
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin && paths.has(url.pathname) && !url.search && request.method() === 'GET') {
      await route.continue();
    } else {
      unexpected.push(url.pathname);
      await route.abort();
    }
  });
  await page.routeWebSocket('**/*', (socket) => {
    unexpected.push('WebSocket');
    void socket.close();
  });
  return async () => {
    assert.equal(external.length, 0, `Non-loopback requests observed: ${external.length}`);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(await page.evaluate(() => window.replayPolicyViolations), []);
    assert.deepEqual(pageErrors, []);
    return external.length;
  };
}

export async function browserReplay(page, { gesture, capture = async () => {}, source = 'preview' } = {}) {
  const status = page.locator('.lens-status');
  const action = page.locator('.lens-action');
  const next = () => page.locator('#next').click();
  gesture ??= (name) => page.locator(`#${name === 'click' ? 'tap' : name}`).click();
  async function frame(name, statusText, actionText) {
    await page.waitForFunction(({ statusText, actionText }) =>
      document.querySelector('.lens-status')?.textContent === statusText &&
      (actionText === undefined || document.querySelector('.lens-action')?.textContent === actionText),
    { statusText, actionText }, { timeout: 7000 });
    assert.equal(await status.textContent(), statusText);
    if (actionText !== undefined) assert.equal(await action.textContent(), actionText);
    await capture(name, page);
  }
  async function run() {
    await frame('01-watching', 'Watching');
    await next();
    await frame('02-a01-open', 'Alert A01', '› Snooze 60s');
    await gesture('click');
    await frame('03-a01-snoozed', 'Snoozed · A01', 'Review at 01:05');
    await next();
    await frame('04-a01-snoozed-8c', 'Snoozed · A01', 'Review at 01:05');
    await next();
    await frame('05-a01-review', 'Review A01', '› Snooze 60s');
    await gesture('up');
    await frame('06-a01-escalate-selected', 'Review A01', '› Escalate');
    await gesture('click');
    await frame('07-a01-mock-receipt', 'Mock receipt A01', 'MOCK · R-A01');
    await next();
    await frame('08-recovered', 'Watching');
    await next();
    await frame('09-a02-open', 'Alert A02', '› Snooze 60s');
    await gesture('down');
    await frame('10-a02-ack-selected', 'Alert A02', '› Acknowledge');
    await gesture('click');
    await frame('11-a02-seen', 'Seen A02');
    const activity = await page.locator('#activity li').allTextContents();
    const inbox = await page.locator('#inbox li').allTextContents();
    assert.equal(activity.length, 3);
    assert.equal(activity.filter((line) => line.startsWith('Escalated A01')).length, 1);
    assert.ok(activity.every((line) => line.includes(source)));
    assert.equal(inbox.length, 1);
    assert.match(inbox[0], /A01 · R-A01/);
    await capture('12-activity', page, { activity, inbox });
    await page.locator('#reset').click();
    await frame('13-reset', 'Watching');
    assert.equal(await page.locator('#replay-time').textContent(), '00:00');
    assert.equal(await page.locator('#activity li, #inbox li').count(), 0);
    return { activity, inbox };
  }
  const first = await run();
  if (source === 'preview') assert.deepEqual(await run(), first);
  return first;
}

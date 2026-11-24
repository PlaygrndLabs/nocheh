/**
 * Opens every dashboard page and tab of a running fixture in Chromium and
 * reports what the owner would see: the page heading, uncaught errors, console
 * errors and owner API calls that failed; then Hermes's Sessions and Files pages, which must carry their
 * reported script rules and draw no report, and Hermes's chat page, which the dashboard refuses while it is off.
 * Runs inside the tester's browser container on the fixture network (deploy/acceptance/browser.Dockerfile).
 *
 * The dashboard answers only its own local address, so a small relay on
 * 127.0.0.1 inside this container forwards to the fixture's dashboard.
 * Usage: node dashboard_pages.mjs <dashboard host> <port> <report directory> <owner password>
 */
import net from 'node:net';
import {writeFileSync} from 'node:fs';
import {chromium} from 'playwright-core';

const [host, port, out, password] = process.argv.slice(2);
const routes = [
  ...[
    ['home', 'Home'],
    ['inbox', 'Inbox'],
    ['tasks', 'Tasks'],
    ['schedules', 'Schedules'],
    ['chats', 'Chats'],
    ['members', 'Members'],
    ['messages', 'Messages'],
    ['memory', 'Memory'],
    ['usage', 'Usage'],
    ['system', 'System'],
    ['connections', 'Connections'],
    ['settings', 'Settings'],
  ],
  ...['allowed', 'history'].map(view => ['inbox?view=' + view, 'Inbox']),
  ...['today', 'upcoming', 'board', 'done', 'dropped', 'archive', 'trash'].map(view => ['tasks?view=' + view, 'Tasks']),
  ['chats?view=rules', 'Chats'],
  ['chats?chat=-10042', 'Chats'],
  ['messages?view=import', 'Messages'],
  ...['people', 'projects', 'notes', 'longterm', 'facts'].map(view => ['memory?view=' + view, 'Memory']),
  ...['work', 'sends', 'machines', 'backups', 'databases'].map(view => ['system?view=' + view, 'System']),
  ...['projects', 'github'].map(view => ['connections?view=' + view, 'Connections']),
  ...['telegram', 'models', 'speed', 'privacy', 'assistant', 'tasks', 'machines', 'advanced'].map(view => ['settings?view=' + view, 'Settings']),
  // Connections was a Settings tab; its old address opens the Connections page (ADR-0271).
  ['settings?view=connections', 'Connections'],
];

const relay = net
  .createServer(client => {
    const upstream = net.connect(Number(port), host);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.pipe(upstream).pipe(client);
  })
  .listen(Number(port), '127.0.0.1');
await new Promise(resolve => relay.on('listening', resolve));

const browser = await chromium.launch({args: ['--no-sandbox', '--disable-crash-reporter', '--disable-crashpad-for-testing']});
// Every page opens signed in: the first sign-in on a fresh fixture creates the password, later ones use it.
const context = await browser.newContext({viewport: {width: 1440, height: 900}});
const login = await context.request.post(`http://127.0.0.1:${port}/api/nocheh/login`, {data: {password}});
if (!login.ok()) throw new Error(`sign-in failed: ${login.status()} ${await login.text()}`);
const results = [];
for (const [route, title] of routes) {
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', error => problems.push('page error: ' + error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) problems.push('console: ' + message.text());
  });
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/nocheh') && response.status() >= 500)
      problems.push(`api ${response.status()}: ${url.pathname}`);
  });
  let heading = null;
  try {
    await page.goto(`http://127.0.0.1:${port}/#${route}`, {timeout: 60000});
    await page.locator('main h1').first().waitFor({timeout: 30000});
    // Pages poll the owner API, so the network never goes idle; give data a moment to arrive.
    await page.waitForTimeout(2500);
    heading = (await page.locator('main h1').first().textContent()).trim();
    const alerts = await page.getByRole('alert').allTextContents();
    for (const text of alerts) if (text.trim()) problems.push('alert: ' + text.trim().slice(0, 200));
    await page.screenshot({path: `${out}/${route.replace(/\?view=|[?=]/g, '-')}.png`});
  } catch (error) {
    problems.push('did not open: ' + String(error.message).split('\n')[0]);
  }
  results.push({route, heading, passed: heading === title && !problems.length, problems});
  await page.close();
}
// Hermes's own pages carry script rules that are only reported for now (ADR-0251). The browser fires a
// securitypolicyviolation event for each report too, so a missing rule or any report fails here: a Hermes update
// that adds a script the rules would block is caught before they are enforced.
for (const route of ['sessions', 'files']) {
  const page = await context.newPage();
  const problems = [];
  await page.addInitScript(() => {
    window.__nochehScriptReports = [];
    document.addEventListener('securitypolicyviolation', event =>
      window.__nochehScriptReports.push(`${event.effectiveDirective} ${event.blockedURI || 'inline'} at ${event.sourceFile || 'page'}`),
    );
  });
  page.on('pageerror', error => problems.push('page error: ' + error.message));
  try {
    const response = await page.goto(`http://127.0.0.1:${port}/hermes/${route}`, {timeout: 60000});
    const policy = response?.headers()['content-security-policy-report-only'] ?? '';
    if (!/^script-src 'self' 'nonce-[A-Za-z0-9+/]+=*';/.test(policy)) problems.push('no script rules: ' + (policy || 'none'));
    await page.locator('#root *').first().waitFor({timeout: 30000});
    // A page loads its parts after the first paint.
    await page.waitForTimeout(4000);
    for (const report of await page.evaluate(() => window.__nochehScriptReports)) problems.push('script rule report: ' + report);
    await page.screenshot({path: `${out}/hermes-${route}.png`});
  } catch (error) {
    problems.push('did not open: ' + String(error.message).split('\n')[0]);
  }
  results.push({route: 'hermes/' + route, heading: null, passed: !problems.length, problems});
  await page.close();
}
// The dashboard chat page is off until Nocheh has its own chat page; Telegram only. The dashboard answers with its own
// page, which runs no script and points to Telegram, and Hermes's chat never opens.
{
  const page = await context.newPage();
  const problems = [];
  try {
    const response = await page.goto(`http://127.0.0.1:${port}/hermes/chat`, {timeout: 60000});
    if (response?.status() !== 404) problems.push('chat page answered ' + response?.status());
    const body = (await response?.text()) ?? '';
    if (!/Telegram/.test(body) || /<script/i.test(body)) problems.push('not the chat-off page: ' + body.slice(0, 200));
    await page.screenshot({path: `${out}/hermes-chat-off.png`});
  } catch (error) {
    problems.push('did not open: ' + String(error.message).split('\n')[0]);
  }
  results.push({route: 'hermes/chat', heading: null, passed: !problems.length, problems});
  await page.close();
}
await browser.close();
relay.close();
writeFileSync(`${out}/dashboard-pages.json`, JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify({passed: results.every(row => row.passed), failed: results.filter(row => !row.passed)}));

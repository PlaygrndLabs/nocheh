/**
 * Opens every dashboard page and tab of a running fixture in Chromium and
 * reports what the owner would see: the page heading, uncaught errors, console
 * errors and owner API calls that failed. Runs inside the tester's browser
 * container on the fixture network (deploy/acceptance/browser.Dockerfile).
 *
 * The dashboard answers only its own local address, so a small relay on
 * 127.0.0.1 inside this container forwards to the fixture's dashboard.
 * Usage: node dashboard_pages.mjs <dashboard host> <port> <report directory>
 */
import net from 'node:net';
import {writeFileSync} from 'node:fs';
import {chromium} from 'playwright-core';

const [host, port, out] = process.argv.slice(2);
const routes = [
  ...[
    ['home', 'Home'],
    ['inbox', 'Inbox'],
    ['tasks', 'Tasks'],
    ['chats', 'Chats'],
    ['messages', 'Messages'],
    ['memory', 'Memory'],
    ['usage', 'Usage'],
    ['system', 'System'],
    ['settings', 'Settings'],
  ],
  ...['allowed', 'history'].map(view => ['inbox?view=' + view, 'Inbox']),
  ...['today', 'upcoming', 'board', 'done', 'dropped', 'archive', 'trash'].map(view => ['tasks?view=' + view, 'Tasks']),
  ['chats?view=rules', 'Chats'],
  ['chats?chat=-10042', 'Chats'],
  ['messages?view=import', 'Messages'],
  ...['people', 'projects', 'notes', 'longterm', 'facts'].map(view => ['memory?view=' + view, 'Memory']),
  ...['work', 'backups', 'databases'].map(view => ['system?view=' + view, 'System']),
  ...['telegram', 'models', 'speed', 'privacy', 'assistant', 'tasks', 'advanced'].map(view => ['settings?view=' + view, 'Settings']),
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
const results = [];
for (const [route, title] of routes) {
  const page = await browser.newPage({viewport: {width: 1440, height: 900}});
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
    if (!route.includes('?')) await page.screenshot({path: `${out}/${route}.png`});
  } catch (error) {
    problems.push('did not open: ' + String(error.message).split('\n')[0]);
  }
  results.push({route, heading, passed: heading === title && !problems.length, problems});
  await page.close();
}
await browser.close();
relay.close();
writeFileSync(`${out}/dashboard-pages.json`, JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify({passed: results.every(row => row.passed), failed: results.filter(row => !row.passed)}));

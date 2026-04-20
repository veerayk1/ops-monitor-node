import { chromium, type Browser, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { settings } from '../config.js';

/**
 * Playwright workflow for the RabbitMQ Management UI.
 *
 * Steps:
 *   1. Open the URL
 *   2. Fill username + password, click Login
 *   3. Navigate to the queues page if not already there
 *   4. Type filter text into the Filter input
 *   5. Open the +/- column picker, ensure required columns are checked, close
 *   6. Wait for the table to settle
 *   7. Take a screenshot
 *
 * Selectors use multiple fallbacks because RabbitMQ Management lacks stable test ids.
 */

async function launchBrowser(): Promise<Browser> {
  const headless = settings.browserMode !== 'headed';
  const launchOpts: Parameters<typeof chromium.launch>[0] = { headless };
  if (settings.browserChannel && settings.browserChannel !== 'chromium') {
    launchOpts.channel = settings.browserChannel;
  }
  return chromium.launch(launchOpts);
}

async function login(page: Page, username: string, password: string): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  try {
    await page.waitForSelector("input[name='username'], #login", { timeout: 10_000 });
  } catch {
    return; // Possibly already logged in via cached cookie
  }
  await page.fill("input[name='username']", username);
  await page.fill("input[name='password']", password);
  // Submit
  try {
    await page.click("input[type='submit']", { timeout: 2000 });
  } catch {
    await page.click("button:has-text('Login')");
  }
  await page.waitForLoadState('networkidle');
}

async function gotoQueues(page: Page, baseUrl: string, pagePath: string): Promise<void> {
  const target = baseUrl.replace(/\/$/, '') + pagePath;
  if (page.url() !== target) {
    await page.goto(target);
  }
  try {
    await page.click("a:has-text('Queues')", { timeout: 3000 });
  } catch { /* may already be on queues tab */ }
  await page.waitForLoadState('networkidle');
}

async function applyFilter(page: Page, filterText: string): Promise<void> {
  if (!filterText) return;
  const selectors = [
    'input#msg-filter',
    'input#queues-filter',
    "input[name='filter']",
    "xpath=//*[normalize-space(text())='Filter:']/following::input[1]",
  ];
  for (const sel of selectors) {
    try {
      await page.fill(sel, filterText, { timeout: 3000 });
      break;
    } catch { /* try next */ }
  }
  await page.keyboard.press('Tab');
  await page.waitForTimeout(500);
}

async function ensureColumns(page: Page, columns: string[]): Promise<void> {
  if (columns.length === 0) return;

  const openSelectors = [
    "xpath=//td[normalize-space(text())='+/-']",
    "xpath=//span[normalize-space(text())='+/-']",
    "text=+/-",
  ];

  let opened = false;
  for (const sel of openSelectors) {
    try {
      await page.click(sel, { timeout: 2000 });
      opened = true;
      break;
    } catch { /* try next */ }
  }
  if (!opened) return;

  try {
    await page.waitForSelector("text=Columns for this table", { timeout: 3000 });
  } catch { /* picker text may differ across versions */ }

  for (const colLabel of columns) {
    const labelLower = colLabel.toLowerCase();
    const labelXpath =
      `xpath=//label[translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')='${labelLower}']`;
    try {
      const label = await page.waitForSelector(labelXpath, { timeout: 2000 });
      let checkbox = await label.$("input[type='checkbox']");
      if (!checkbox) {
        checkbox = await page.$(`${labelXpath}/preceding::input[@type='checkbox'][1]`);
      }
      if (checkbox) {
        const isChecked = await checkbox.isChecked();
        if (!isChecked) await checkbox.check();
      }
    } catch { /* skip column we couldn't find */ }
  }

  // Close the picker (best-effort)
  for (const sel of openSelectors) {
    try {
      await page.click(sel, { timeout: 1500 });
      break;
    } catch { /* try next */ }
  }
  await page.waitForTimeout(500);
}

async function waitForTableSettle(page: Page): Promise<number> {
  const deadline = 15_000;
  let lastCount = -1;
  let stableFor = 0;
  let elapsed = 0;
  while (elapsed < deadline) {
    const rows = await page.$$('table.list tbody tr, table.list tr.queue-row');
    let count = 0;
    for (const r of rows) {
      const text = (await r.innerText()).trim();
      if (text && !text.split('\n')[0].includes('Name')) count += 1;
    }
    if (count === lastCount && count > 0) {
      stableFor += 1;
      if (stableFor >= 2) break;
    } else {
      stableFor = 0;
    }
    lastCount = count;
    await page.waitForTimeout(500);
    elapsed += 500;
  }
  return Math.max(lastCount, 0);
}

/** Maximum time (ms) for the entire browser workflow before we abort. */
const WORKFLOW_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export async function runWorkflow(args: {
  url: string;
  username: string;
  password: string;
  filterText: string | null;
  ensureCols: string[];
  pagePath: string;
  screenshotPath: string;
}): Promise<number> {
  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Browser workflow timed out after ${WORKFLOW_TIMEOUT_MS / 1000}s`)), WORKFLOW_TIMEOUT_MS);
  });

  const workflowPromise = (async () => {
    await page.goto(args.url, { waitUntil: 'domcontentloaded' });
    await login(page, args.username, args.password);
    await gotoQueues(page, args.url, args.pagePath);
    await applyFilter(page, args.filterText ?? '');
    await ensureColumns(page, args.ensureCols);
    const rowCount = await waitForTableSettle(page);
    mkdirSync(dirname(args.screenshotPath), { recursive: true });
    await page.screenshot({ path: args.screenshotPath, fullPage: true });
    return rowCount;
  })();

  try {
    return await Promise.race([workflowPromise, timeoutPromise]);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

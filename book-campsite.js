/**
 * Ontario Parks Campsite Auto-Booker
 * ------------------------------------
 * Tries sites in the order you supply. If a site shows "not yet allowed"
 * it keeps retrying that site until the window opens or attempts run out,
 * then moves to the next. The booking window opens at 7:00 AM on the date
 * exactly 5 months before the desired start date.
 *
 * Usage:
 *   node book-campsite.js                          # waits for 6:59 AM, uses default sites
 *   node book-campsite.js --now                    # skips the wait, runs immediately
 *   node book-campsite.js --sites 228,201,210      # override site priority list
 *   node book-campsite.js --attempts 10            # max retries per site (default 200)
 *   node book-campsite.js --now --debug            # dump DOM info and exit
 *
 * Requirements:
 *   npm install
 *   npx playwright install chromium
 */

'use strict';

const { chromium } = require('playwright');

// ─── CLI argument parsing ────────────────────────────────────────────────────

/**
 * Parse --key value or --key=value pairs from process.argv.
 * Returns undefined if the flag is absent.
 */
function getArg(name) {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  const pair = process.argv.find((a) => a.startsWith(`${flag}=`));
  return pair ? pair.slice(flag.length + 1) : undefined;
}

// ─── Configuration ──────────────────────────────────────────────────────────

// Booking start date (from URL). The window opens at 7:00 AM exactly
// 5 months before this date (Ontario Parks rule).
const BOOKING_START_DATE = '2026-10-08'; // YYYY-MM-DD — your check-in date
const BOOKING_END_DATE   = '2026-10-09'; // YYYY-MM-DD — your check-out date

// Compute nights automatically from the two dates above
const _msPerDay = 24 * 60 * 60 * 1000;
const BOOKING_NIGHTS = Math.round(
  (new Date(BOOKING_END_DATE) - new Date(BOOKING_START_DATE)) / _msPerDay
);

/**
 * Compute the booking-open datetime: 7:00 AM on the date 5 months
 * before the campsite start date, in the local system timezone.
 */
function computeBookingOpenTime(startDateStr) {
  const [year, month, day] = startDateStr.split('-').map(Number);
  // Subtract 5 months
  let openMonth = month - 5;
  let openYear = year;
  if (openMonth <= 0) { openMonth += 12; openYear -= 1; }
  const openDate = new Date(openYear, openMonth - 1, day, 7, 0, 0, 0);
  return openDate;
}

// Sites to try — can be overridden with --sites 228,201,210
const defaultSites = ['228', '191', '189'];
const sitesArg = getArg('sites');
const siteLabels = sitesArg ? sitesArg.split(',').map((s) => s.trim()) : defaultSites;

// Max retries per site — can be overridden with --attempts 10
const attemptsArg = getArg('attempts');
const maxRetryAttempts = attemptsArg ? parseInt(attemptsArg, 10) : 200;

const CONFIG = {
  // Ordered list of sites to try (1st = highest priority).
  // Pass --sites 228,201,210 to override.
  sites: siteLabels.map((label) => ({ label })),

  // Start hammering Reserve 1 minute before the booking window opens
  preLoadSecondsBefore: 60,

  // Computed from BOOKING_START_DATE: 7:00 AM, 5 months before start date
  bookingOpenTime: computeBookingOpenTime(BOOKING_START_DATE),

  // Max retry attempts when "not yet allowed" sidebar alert is shown.
  // ~300 ms per attempt → 200 attempts ≈ 60 s of retrying.
  // Override with --attempts N.
  maxRetryAttempts,

  // Base URL — searchTime is replaced dynamically at runtime
  baseUrl:
    'https://reservations.ontarioparks.ca/create-booking/results'
    + '?transactionLocationId=-2147483625'
    + '&resourceLocationId=-2147483627'
    + '&mapId=-2147483559'
    + '&searchTabGroupId=0'
    + '&bookingCategoryId=0'
    + `&startDate=${BOOKING_START_DATE}`
    + `&endDate=${BOOKING_END_DATE}`
    + `&nights=${BOOKING_NIGHTS}`
    + '&isReserving=true'
    + '&equipmentId=-32768'
    + '&subEquipmentId=-32768'
    + '&peopleCapacityCategoryCounts=%5B%5B-32768,null,1,null%5D%5D'
    + '&filterData=%7B%22-32736%22:%22%5B%5B1%5D,0,0,0%5D%22,%22-32726%22:%22%5B%5B1%5D,0,0,0%5D%22%7D'
    + '&flexibleSearch=%5Bfalse,false,%222026-05-01%22,1%5D',

  // Run with a visible browser window so you can monitor progress
  headless: false,

  // How long to wait for the map to fully render after page load (ms)
  mapRenderTimeout: 40000,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

/** Returns the target Date (1 minute before booking open) or null if already past. */
function getTargetTime() {
  const now = new Date();
  // Start attempting 1 minute before the window opens
  const target = new Date(CONFIG.bookingOpenTime.getTime() - 60 * 1000);
  return target > now ? target : null;
}

/** Build the booking URL with a fresh searchTime so the server accepts it. */
function buildUrl() {
  const searchTime = new Date().toISOString().replace('Z', '');
  return `${CONFIG.baseUrl}&searchTime=${encodeURIComponent(searchTime)}&view=map`;
}

/**
 * Precision wait — coarse sleep first, then 50 ms polling for the final two
 * seconds so we land within ±50 ms of the target timestamp.
 */
async function waitUntil(targetMs) {
  const coarseWait = targetMs - Date.now() - 2000;
  if (coarseWait > 0) {
    log(`Sleeping ${Math.round(coarseWait / 1000)}s (coarse)…`);
    await sleep(coarseWait);
  }
  while (Date.now() < targetMs) {
    await sleep(50);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function bookCampsite() {
  const runNow = process.argv.includes('--now');
  const debugMode = process.argv.includes('--debug');
  const targetTime = runNow ? null : getTargetTime();

  const openTimeStr = CONFIG.bookingOpenTime.toLocaleString();
  log('Ontario Parks Campsite Auto-Booker starting…');
  log(`Sites (priority order): ${CONFIG.sites.map((s) => s.label).join(' → ')}`);
  log(`Booking opens         : ${openTimeStr}`);
  log(`Max attempts per site : ${CONFIG.maxRetryAttempts}`);
  log(`Start hammering at    : T-60s (${new Date(CONFIG.bookingOpenTime.getTime() - 60000).toLocaleTimeString()})`);
  log('Pass --sites 228,201,210 to change priority  |  --attempts N to change retries');

  // ── Launch browser or connect to existing Chrome ────────────────────────
  // Chrome must be running with --remote-debugging-port=9222 for tab reuse.
  // Start it once with:
  //   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
  // After that, every run will open a new tab in the existing window.
  let browser;
  let browserContext;

  try {
    browser = await chromium.connectOverCDP('http://localhost:9222');
    // Use the first existing context (the normal Chrome window)
    browserContext = browser.contexts()[0];
    log('Connected to existing Chrome — opening new tab…');
  } catch {
    // No Chrome with remote debugging — launch a fresh instance
    browser = await chromium.launch({ headless: CONFIG.headless, channel: 'chrome' });
    browserContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    log('No existing Chrome found — launched new instance.');
  }

  const page = await browserContext.newPage();

  // ── Pre-load or wait ────────────────────────────────────────────────────
  if (targetTime) {
    const preLoadMs = targetTime.getTime(); // targetTime is already T-60s

    if (Date.now() < preLoadMs) {
      log(`Waiting to pre-load page (T-60s before booking opens)…`);
      await waitUntil(preLoadMs);
    }

    log('Pre-loading map page…');
    await page.goto(buildUrl(), { waitUntil: 'networkidle', timeout: CONFIG.mapRenderTimeout });
    log(`Page loaded. Waiting for booking window to open at ${CONFIG.bookingOpenTime.toLocaleTimeString()}…`);
    await waitUntil(CONFIG.bookingOpenTime.getTime());

    // Reload with a fresh searchTime at the exact moment
    log('⏰  Booking window open! Reloading with fresh search time…');
    await page.goto(buildUrl(), { waitUntil: 'networkidle', timeout: CONFIG.mapRenderTimeout });
  } else {
    log('Running immediately (--now mode)…');
    await page.goto(buildUrl(), { waitUntil: 'networkidle', timeout: CONFIG.mapRenderTimeout });
  }

  log('Map fully rendered.');

  // ── Dismiss cookie consent banner if present ─────────────────────────────
  const cookieDismissed = await page.evaluate(() => {
    const container = document.querySelector('mat-dialog-container');
    if (!container) return false;
    const text = container.textContent || '';
    if (!text.includes('cookies')) return false;
    // Try common accept/close buttons inside the cookie banner
    const btn =
      container.querySelector('button[id*="accept"]') ||
      container.querySelector('button[id*="close"]') ||
      container.querySelector('button[id*="agree"]') ||
      container.querySelector('button');
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (cookieDismissed) {
    log('Cookie consent banner dismissed.');
    await sleep(400);
  }


  if (debugMode) {
    const currentUrl = page.url();
    const title = await page.title();
    log(`\n[DEBUG] Current URL : ${currentUrl}`);
    log(`[DEBUG] Page title  : ${title}`);

    // Check for canvas (map rendered via WebGL/canvas — z-index won't work)
    const canvasCount = await page.locator('canvas').count();
    log(`[DEBUG] Canvas elements found: ${canvasCount}`);

    // Check for iframes
    const iframeCount = await page.locator('iframe').count();
    log(`[DEBUG] Iframe elements found: ${iframeCount}`);

    // Scan inline-style z-index (standard DOM)
    log('\n[DEBUG] Scanning DOM for all elements with inline z-index…');
    const zIndexElements = await page.evaluate(() => {
      const all = document.querySelectorAll('[style]');
      const found = [];
      all.forEach((el) => {
        const zi = el.style.zIndex;
        if (zi && zi !== '' && zi !== 'auto') {
          found.push({
            zIndex: zi,
            tag: el.tagName,
            id: el.id || '',
            classes: el.className.toString().slice(0, 60),
            text: el.textContent.trim().slice(0, 40),
          });
        }
      });
      return found.sort((a, b) => Number(b.zIndex) - Number(a.zIndex));
    });

    if (zIndexElements.length === 0) {
      log('[DEBUG] No inline z-index found.');
      log('[DEBUG] Trying computed z-index on all elements (top 20 highest)…');
      const computed = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('*'));
        const found = [];
        all.forEach((el) => {
          const zi = window.getComputedStyle(el).zIndex;
          if (zi && zi !== 'auto' && Number(zi) > 100) {
            found.push({
              zIndex: Number(zi),
              tag: el.tagName,
              id: el.id || '',
              classes: (el.className || '').toString().slice(0, 60),
              text: el.textContent.trim().slice(0, 40),
            });
          }
        });
        return found.sort((a, b) => b.zIndex - a.zIndex).slice(0, 20);
      });
      computed.forEach((el) => {
        log(`  computed z-index:${el.zIndex}  <${el.tag}> id="${el.id}" class="${el.classes}" text="${el.text}"`);
      });
    } else {
      log(`[DEBUG] Found ${zIndexElements.length} elements with inline z-index:`);
      zIndexElements.forEach((el) => {
        log(`  z-index:${el.zIndex}  <${el.tag}> id="${el.id}" class="${el.classes}" text="${el.text}"`);
      });
    }

    // List top-level Angular components visible in the DOM
    log('\n[DEBUG] Angular components found on page:');
    const components = await page.evaluate(() => {
      const els = document.querySelectorAll('[_nghost-ng-c],[class*="ng-"]');
      return Array.from(els).slice(0, 15).map((el) => ({
        tag: el.tagName,
        id: el.id || '',
        classes: (el.className || '').toString().slice(0, 80),
      }));
    });
    components.forEach((c) => log(`  <${c.tag}> id="${c.id}" class="${c.classes}"`));

    log('\n[DEBUG] Done. Share this output to identify the correct selectors.\n');
    return;
  }

  // ── Try each site in priority order ──────────────────────────────────────
  let booked = false;

  for (const site of CONFIG.sites) {
    if (booked) break;

    // Step 1 & 2: Find the site label on the Leaflet map and click its icon
    log(`\n── Trying Site ${site.label} ──`);
    log('Waiting for map-site-label marker…');

    // First wait for any label to appear (map rendered), then filter for ours
    try {
      await page.waitForSelector('div.map-site-label', { state: 'attached', timeout: 20000 });
    } catch {
      log('ERROR: No map-site-label elements appeared within 20 s — map did not render.');
      break;
    }

    // Each campsite has a label div showing the site number.
    // We use exact text match so "228" doesn't match "2280" etc.
    // All geometry is computed inside the page context to avoid Playwright's
    // visibility checks (Leaflet markers are inside overflow:hidden containers).
    const clicked = await page.evaluate((siteLabel) => {
      // Find the label div with this exact site number
      const labels = Array.from(document.querySelectorAll('div.map-site-label'));
      const label = labels.find((el) => el.textContent.trim() === siteLabel);
      if (!label) return { ok: false, reason: 'label not found' };

      const lr = label.getBoundingClientRect();
      const lx = lr.x + lr.width / 2;
      const ly = lr.y + lr.height / 2;

      // Find the closest map-icon to this label (same lat/lng on the Leaflet map)
      const icons = Array.from(document.querySelectorAll('div.leaflet-marker-icon.map-icon'));
      if (icons.length === 0) return { ok: false, reason: 'no map-icon elements found' };

      let best = null;
      let bestDist = Infinity;
      icons.forEach((el) => {
        const r = el.getBoundingClientRect();
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        const dist = Math.hypot(cx - lx, cy - ly);
        if (dist < bestDist) { bestDist = dist; best = el; }
      });

      best.click();
      return { ok: true, dist: Math.round(bestDist) };
    }, site.label);

    if (!clicked.ok) {
      log(`ERROR: Could not click Site ${site.label} — ${clicked.reason}.`);
      continue;
    }

    log(`Clicked icon for Site ${site.label} (${clicked.dist}px from label).`);

    // Step 3: Wait for sidebar, then check if the site is already taken
    try {
      await page.waitForSelector('app-side-bar-site-details', { timeout: 8000 });
    } catch {
      log(`ERROR: Sidebar did not appear after clicking Site ${site.label}.`);
      continue;
    }

    // Wait for the sidebar to show THIS site's name (it may lag from a previous click)
    let siteName = '';
    for (let i = 0; i < 20; i++) {
      siteName = await page.locator('#resourceName').textContent({ timeout: 3000 }).catch(() => '');
      if (siteName.includes(site.label)) break;
      await sleep(300);
    }
    log(`Sidebar site: "${siteName.trim()}"`);

    // Check for the alert box in the sidebar.
    // If it shows the site is genuinely taken by someone else → skip to next site.
    // If it shows "not yet allowed" → proceed to Reserve anyway; the popup after
    // clicking Reserve is the authoritative signal (and we handle it in the loop).
    const alertBox = page.locator(
      'app-side-bar-site-details #sidebarRestrictiveMessageHeading'
    );
    const alertVisible = await alertBox.isVisible().catch(() => false);

    if (alertVisible) {
      const alertText = await alertBox.textContent().catch(() => '');
      const notYetOpen =
        alertText.includes('not yet allowed') ||
        alertText.includes('cannot be reserved until');

      if (notYetOpen) {
        // Window not open yet — fall through and let the Reserve popup loop handle it
        log(`Site ${site.label}: sidebar says not yet open — proceeding to click Reserve…`);
      } else {
        // Taken by someone else — move to next site
        log(`Site ${site.label} is already booked by someone else — trying next site…`);
        continue;
      }
    }

    // Steps 4–6: Click Reserve, handle dialogs, retry loop
    log(`Site ${site.label} — starting reservation attempts (max ${CONFIG.maxRetryAttempts})…`);

    let attempt = 0;

    while (!booked && attempt < CONFIG.maxRetryAttempts) {
      attempt++;

      // Click the Reserve button entirely inside the page context to bypass
      // Playwright's visibility checks (button is inside overflow:hidden sidebar)
      const btnResult = await page.evaluate(() => {
        const spans = Array.from(document.querySelectorAll('.mdc-button__label'));
        const btn = spans.find((el) => el.textContent.trim() === 'Reserve');
        if (!btn) return 'not_found';
        const button = btn.closest('button') || btn;
        button.click();
        return 'clicked';
      });

      if (btnResult === 'not_found') {
        log(`Attempt ${attempt}: Reserve button not found in DOM yet, retrying…`);
        await sleep(300);
        continue;
      }

      log(`Attempt ${attempt}: Reserve clicked — checking for dialog…`);

      // Wait up to 800ms for a dialog to appear
      await sleep(800);

      // Use evaluate to check dialog presence — avoids Playwright visibility false-negatives
      const dialogInfo = await page.evaluate(() => {
        const container = document.querySelector('mat-dialog-container');
        if (!container) return null;
        const titleEl = container.querySelector('mat-dialog-title, h2, [mat-dialog-title]');
        return {
          title: titleEl ? titleEl.textContent.trim() : '',
          body: container.textContent.trim(),
        };
      });

      if (!dialogInfo) {
        // No dialog → success
        log(`\n✅  SUCCESS on attempt ${attempt} for Site ${site.label}!`);
        log('Complete your personal details and payment to finish the booking.');
        booked = true;
        break;
      }

      const { title: dialogTitle, body: dialogBody } = dialogInfo;

      const isPriorToVisit = dialogBody.includes('Prior to your visit');

      if (isPriorToVisit) {
        // This is the post-Reserve acknowledgement popup — click #confirmButton
        log(`Attempt ${attempt}: "Prior to your visit" popup — clicking Acknowledge…`);
        const acknowledged = await page.evaluate(() => {
          const btn = document.querySelector('#confirmButton');
          if (btn) { btn.click(); return true; }
          return false;
        });
        if (!acknowledged) {
          await page.keyboard.press('Escape');
          log('WARNING: #confirmButton not found — sent Escape instead.');
        }
        log(`\n✅  SUCCESS on attempt ${attempt} for Site ${site.label}!`);
        log('Complete your personal details and payment to finish the booking.');
        booked = true;
        break;
      }

      const isNotYetAllowed =
        dialogBody.includes('not yet allowed') ||
        dialogBody.includes('cannot be reserved until');
      const isCannotReserve =
        dialogTitle.includes('Cannot Reserve') ||
        dialogBody.includes('Cannot Reserve');

      if (isNotYetAllowed || isCannotReserve) {
        // Close #closeButton via evaluate
        const closed = await page.evaluate(() => {
          const btn = document.querySelector('#closeButton');
          if (btn) { btn.click(); return true; }
          return false;
        });

        if (!closed) {
          await page.keyboard.press('Escape');
          log(`Attempt ${attempt}: #closeButton not found, sent Escape.`);
        }

        await sleep(300);

        if (isCannotReserve) {
          log(`Attempt ${attempt}: "Cannot Reserve" popup closed — retrying…`);
        } else {
          log(`Attempt ${attempt}: "Not yet allowed" popup closed — retrying…`);
        }
        continue;
      }

      // Unknown dialog — check if it's a stale cookie banner, otherwise stop
      const preview = dialogBody.trim().slice(0, 120);
      if (dialogBody.includes('cookies')) {
        log(`Attempt ${attempt}: Cookie banner still present — dismissing and retrying…`);
        await page.evaluate(() => {
          const c = document.querySelector('mat-dialog-container');
          const btn = c && c.querySelector('button');
          if (btn) btn.click();
        });
        await sleep(300);
        continue;
      }
      log(`Attempt ${attempt}: Unexpected dialog: "${preview}"`);
      log('Browser left open — complete the booking manually.');
      booked = true;
      break;
    }

    if (!booked) {
      log(`Site ${site.label}: all ${CONFIG.maxRetryAttempts} attempts exhausted — trying next site…`);
    }
  } // end for (const site of CONFIG.sites)

  if (!booked) {
    log('\n❌  Could not book any site. All sites were taken or attempts exhausted.');
    log('The browser is still open — you can try manually.');
  }

  // Keep the browser open so the user can finish the booking form
  log('Browser left open. Close it manually when done.');
}

bookCampsite().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

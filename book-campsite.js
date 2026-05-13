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

// ─── User Configuration ──────────────────────────────────────────────────────
// Edit the values in this block before each booking run.

// ── Booking dates ──
const BOOKING_START_DATE = '2026-10-09'; // YYYY-MM-DD — check-in date
const BOOKING_END_DATE   = '2026-10-11'; // YYYY-MM-DD — check-out date (nights auto-computed)

// ── Ontario Parks login credentials ──
const LOGIN_EMAIL    = 'victoryssmile@hotmail.com';
const LOGIN_PASSWORD = '';

// ── Campsite priority list ──
// Sites are tried in order — first available wins.
// Override at runtime with: --sites 228,201,210
const DEFAULT_SITES = ['228', '186', '189'];


// ── Timing (seconds before 7:00 AM) ──
const PRE_RELOAD_SECONDS = 60;  // reload booking page this many seconds before window opens
const PRE_LOGIN_SECONDS  = 300; // start login this many seconds before window opens (≥ PRE_RELOAD_SECONDS)

// ─── Derived values (do not edit) ────────────────────────────────────────────

const _msPerDay = 24 * 60 * 60 * 1000;
const BOOKING_NIGHTS = Math.round(
  (new Date(BOOKING_END_DATE) - new Date(BOOKING_START_DATE)) / _msPerDay
);

function computeBookingOpenTime(startDateStr) {
  const [year, month, day] = startDateStr.split('-').map(Number);
  let openMonth = month - 5;
  let openYear = year;
  if (openMonth <= 0) { openMonth += 12; openYear -= 1; }
  return new Date(openYear, openMonth - 1, day, 7, 0, 0, 0); // ← PRODUCTION: 7:00 AM
//   const t = new Date(Date.now() + 3 * 60 * 1000);            // ← TESTING:    2 minutes from now, :00 seconds
//   t.setSeconds(0, 0);
//   return t;
}

const sitesArg = getArg('sites');
const siteLabels = sitesArg ? sitesArg.split(',').map((s) => s.trim()) : DEFAULT_SITES;

const attemptsArg = getArg('attempts');
const maxRetryAttempts = attemptsArg ? parseInt(attemptsArg, 10) : 200;

const CONFIG = {
  // ── Mirrors the user-editable constants above ──
  loginEmail:            LOGIN_EMAIL,
  loginPassword:         LOGIN_PASSWORD,
  sites:                 siteLabels.map((label) => ({ label })),
  preReloadSecondsBefore: PRE_RELOAD_SECONDS,
  preLoginSecondsBefore:  PRE_LOGIN_SECONDS,

  // Computed booking-open time: 7:00 AM, 5 months before start date
  bookingOpenTime: computeBookingOpenTime(BOOKING_START_DATE),

  // Max retry attempts. ~300 ms each → 200 ≈ 60 s. Override with --attempts N.
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

  headless: false,
  mapRenderTimeout: 40000,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(msg) {
  const n = new Date();
  const ts = `${n.getHours().toString().padStart(2,'0')}:${n.getMinutes().toString().padStart(2,'0')}:${n.getSeconds().toString().padStart(2,'0')}.${n.getMilliseconds().toString().padStart(3,'0')}`;
  console.log(`[${ts}] ${msg}`);
}

/** Returns the login start time (PRE_LOGIN_SECONDS before booking opens) or null if already past. */
function getLoginStartTime() {
  const now = new Date();
  const target = new Date(CONFIG.bookingOpenTime.getTime() - CONFIG.preLoginSecondsBefore * 1000);
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
  // Fine-grained: poll every 1 ms for the final 2 seconds → ≤1 ms overshoot
  while (Date.now() < targetMs) {
    await sleep(1);
  }
}

// ─── Browser helpers ─────────────────────────────────────────────────────────

/** Dismiss the Ontario Parks cookie consent banner if present. */
async function dismissCookieBanner(page) {
  const dismissed = await page.evaluate(() => {
    const container = document.querySelector('mat-dialog-container');
    if (!container) return false;
    const text = container.textContent || '';
    if (!text.includes('cookies')) return false;
    const btn =
      container.querySelector('button[id*="accept"]') ||
      container.querySelector('button[id*="close"]') ||
      container.querySelector('button[id*="agree"]') ||
      container.querySelector('button');
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (dismissed) {
    log('Cookie consent banner dismissed.');
    await sleep(400);
  }
}

/**
 * Log in to Ontario Parks, then navigate to the booking URL on the same tab.
 * Steps: click "Sign in" → fill email + password → submit → navigate to booking URL.
 */
async function performLogin(page) {
  log('Navigating to booking page for login…');
  await page.goto(buildUrl(), { waitUntil: 'networkidle', timeout: CONFIG.mapRenderTimeout });
  await dismissCookieBanner(page);

  // If already logged in (no "Sign in" button visible), skip login
  const signInFound = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('button, a'));
    const btn = all.find((el) => el.textContent.trim() === 'Sign in');
    if (btn) { btn.click(); return true; }
    return false;
  });

  if (!signInFound) {
    log('Sign in button not found — may already be logged in, continuing…');
    return;
  }

  log('Sign in clicked — waiting for email input…');

  // Wait for the email field to appear (handles both modal and page navigation)
  try {
    await page.waitForSelector('input[type="email"]', { state: 'attached', timeout: 10000 });
  } catch {
    log('WARNING: Email input did not appear within 10 s — login form may not have opened.');
    return;
  }

  log('Login form ready — filling credentials…');

  // Use Playwright's native fill() which works reliably with Angular reactive forms
  await page.fill('input[type="email"]',    CONFIG.loginEmail);
  await page.fill('input[type="password"]', CONFIG.loginPassword);

  log('Credentials filled — submitting…');

  // Click the submit button — try the form's submit button first, fall back to any "Sign in"
  const submitted = await page.evaluate(() => {
    // Look for submit button inside a form first
    const formBtn = document.querySelector('form button[type="submit"]');
    if (formBtn) { formBtn.click(); return 'form-submit'; }
    // Fall back to any button with Sign in text
    const all = Array.from(document.querySelectorAll('button'));
    const btn = all.find((el) => el.textContent.trim() === 'Sign in');
    if (btn) { btn.click(); return 'sign-in-btn'; }
    return null;
  });

  if (!submitted) {
    log('WARNING: Could not find submit button — trying Enter key…');
    await page.keyboard.press('Enter');
  } else {
    log(`Submitted via ${submitted}.`);
  }

  // Wait for the full OAuth redirect chain AND for Angular to process the auth token.
  // Ontario Parks uses a code-exchange flow: login → redirect with ?code=xxx → Angular
  // processes the code → sets session → renders "Welcome,". We MUST wait for that final
  // render before navigating away, otherwise the in-flight token exchange is interrupted.
  log('Waiting for auth redirect and session initialization…');
  try {
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('span')).some((el) => el.textContent.includes('Welcome,')),
      { timeout: 25000, polling: 500 }
    );
    log('Login verified — "Welcome," span found, session is initialized.');
  } catch {
    log('WARNING: "Welcome," span did not appear within 25 s — login may have failed.');
  }

  // Give Angular one more tick to persist auth tokens to storage before we navigate.
  await sleep(1500);

  // Now it is safe to navigate — the session cookie/token is fully saved.
  log(`Navigating to booking URL on same tab (currently: ${page.url()})…`);
  await page.goto(buildUrl(), { waitUntil: 'networkidle', timeout: CONFIG.mapRenderTimeout });
  await dismissCookieBanner(page);

  // Confirm session survived the navigation
  const sessionOk = await page.evaluate(() =>
    Array.from(document.querySelectorAll('span')).some((el) => el.textContent.includes('Welcome,'))
  );
  if (sessionOk) {
    log('Session confirmed on booking page — ready to book.');
  } else {
    log('WARNING: Session lost after navigating to booking page — you may need to log in manually.');
  }
}

// ─── Per-site booking ────────────────────────────────────────────────────────

/**
 * Attempt to book one site on a page that is already on the booking URL.
 * `shared` is a plain object { booked: false }.
 * Sets shared.booked = true on success. Returns true on success, false otherwise.
 */
async function bookSiteOnPage(page, site, shared) {
  const tag = `[Site ${site.label}]`;

  if (shared.booked) return false;

  // If the page is not already on the booking map, navigate there first.
  const currentUrl = page.url();
  if (!currentUrl.includes('reservations.ontarioparks.ca') || !currentUrl.includes('view=map')) {
    log(`${tag} Navigating to booking URL…`);
    await page.goto(buildUrl(), { waitUntil: 'networkidle', timeout: CONFIG.mapRenderTimeout });
    await dismissCookieBanner(page);
  }

  if (shared.booked) return false;

  log(`${tag} Waiting for map markers…`);
  try {
    await page.waitForSelector('div.map-site-label', { state: 'attached', timeout: 20000 });
  } catch {
    log(`${tag} ERROR: Map did not render within 20 s.`);
    return false;
  }

  const clicked = await page.evaluate((siteLabel) => {
    const labels = Array.from(document.querySelectorAll('div.map-site-label'));
    const label = labels.find((el) => el.textContent.trim() === siteLabel);
    if (!label) return { ok: false, reason: 'label not found' };

    // Strategy 1: label is a child of the icon div — exact, zero error
    const parentIcon = label.closest('div.leaflet-marker-icon.map-icon');
    if (parentIcon) {
      parentIcon.click();
      return { ok: true, dist: 0, method: 'closest' };
    }

    // Strategy 2: match by Leaflet CSS transform position.
    // Both the label marker and icon marker for the same site are placed at
    // the exact same pixel coordinate via translate3d(). This is far more
    // reliable than pixel distance between bounding-box centers.
    const getLabelTransform = (el) => {
      // Walk up to find the element with a translate3d transform (the Leaflet marker root)
      let cur = el;
      while (cur && cur !== document.body) {
        const t = cur.style && cur.style.transform;
        if (t && t.includes('translate')) return { el: cur, transform: t };
        cur = cur.parentElement;
      }
      return null;
    };
    const parseTranslate = (t) => {
      const m = t.match(/translate3d\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px/) ||
                t.match(/translate\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px/);
      return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : null;
    };

    const labelMarkerInfo = getLabelTransform(label);
    if (labelMarkerInfo) {
      const lp = parseTranslate(labelMarkerInfo.transform);
      if (lp) {
        const icons = Array.from(document.querySelectorAll('div.leaflet-marker-icon.map-icon'));
        let best = null, bestDist = Infinity;
        icons.forEach((el) => {
          const ip = parseTranslate(el.style.transform || '');
          if (!ip) return;
          const d = Math.hypot(ip.x - lp.x, ip.y - lp.y);
          if (d < bestDist) { bestDist = d; best = el; }
        });
        if (best && bestDist < 30) {
          best.click();
          return { ok: true, dist: Math.round(bestDist), method: 'transform' };
        }
      }
    }

    // Strategy 3: icon bounding box contains the label center point
    const lr = label.getBoundingClientRect();
    const lx = lr.x + lr.width / 2;
    const ly = lr.y + lr.height / 2;
    const icons = Array.from(document.querySelectorAll('div.leaflet-marker-icon.map-icon'));
    if (icons.length === 0) return { ok: false, reason: 'no map-icon elements found' };

    const containing = icons.find((el) => {
      const r = el.getBoundingClientRect();
      return lx >= r.left && lx <= r.right && ly >= r.top && ly <= r.bottom;
    });
    if (containing) {
      containing.click();
      return { ok: true, dist: 0, method: 'contains' };
    }

    // Strategy 4: nearest icon by pixel distance (last resort)
    let best2 = null, bestDist2 = Infinity;
    icons.forEach((el) => {
      const r = el.getBoundingClientRect();
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      const dist = Math.hypot(cx - lx, cy - ly);
      if (dist < bestDist2) { bestDist2 = dist; best2 = el; }
    });
    best2.click();
    return { ok: true, dist: Math.round(bestDist2), method: 'proximity' };
  }, site.label);

  if (!clicked.ok) {
    log(`${tag} ERROR: Could not click icon — ${clicked.reason}.`);
    return false;
  }
  log(`${tag} Icon clicked via ${clicked.method} (${clicked.dist}px from label).`);

  try {
    await page.waitForSelector('app-side-bar-site-details', { timeout: 8000 });
  } catch {
    log(`${tag} ERROR: Sidebar did not appear.`);
    return false;
  }

  let siteName = '';
  for (let i = 0; i < 20; i++) {
    siteName = await page.locator('#resourceName').textContent({ timeout: 3000 }).catch(() => '');
    if (siteName.includes(site.label)) break;
    await sleep(300);
  }
  log(`${tag} Sidebar: "${siteName.trim()}"`);

  const alertBox = page.locator('app-side-bar-site-details #sidebarRestrictiveMessageHeading');
  const alertVisible = await alertBox.isVisible().catch(() => false);
  if (alertVisible) {
    const alertText = await alertBox.textContent().catch(() => '');
    const notYetOpen =
      alertText.includes('not yet allowed') ||
      alertText.includes('cannot be reserved until');
    if (notYetOpen) {
      log(`${tag} Sidebar says not yet open — proceeding to Reserve…`);
    } else {
      log(`${tag} Already booked by someone else — stopping.`);
      return false;
    }
  }

  const nowMs = () => { const n = new Date(); return `${n.getHours().toString().padStart(2,'0')}:${n.getMinutes().toString().padStart(2,'0')}:${n.getSeconds().toString().padStart(2,'0')}.${n.getMilliseconds().toString().padStart(3,'0')}`; };

  // Wait until exactly the booking open time — all tabs fire Reserve simultaneously
  const openMs = CONFIG.bookingOpenTime.getTime();
  if (Date.now() < openMs) {
    log(`${tag} Pre-loaded and ready — waiting for booking window at ${CONFIG.bookingOpenTime.toLocaleTimeString()}…`);
    await waitUntil(openMs);
  }
  log(`${tag} ⏰  Reserve starting at ${nowMs()}`);

  log(`${tag} Starting reservation attempts (max ${CONFIG.maxRetryAttempts})…`);
  let attempt = 0;

  while (!shared.booked && attempt < CONFIG.maxRetryAttempts) {
    attempt++;

    const btnResult = await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll('.mdc-button__label'));
      const btn = spans.find((el) => el.textContent.trim() === 'Reserve');
      if (!btn) return 'not_found';
      const button = btn.closest('button') || btn;
      button.click();
      return 'clicked';
    });

    if (btnResult === 'not_found') {
      await sleep(300);
      continue;
    }

    log(`${tag} Attempt ${attempt} at ${nowMs()} — waiting for dialog…`);
    await sleep(800);

    if (shared.booked) return false; // another tab already won

    const dialogInfo = await page.evaluate(() => {
      const container = document.querySelector('mat-dialog-container');
      if (!container) return null;
      const titleEl = container.querySelector('mat-dialog-title, h2, [mat-dialog-title]');
      return { title: titleEl ? titleEl.textContent.trim() : '', body: container.textContent.trim() };
    });

    if (!dialogInfo) {
      log(`\n✅  ${tag} SUCCESS on attempt ${attempt}!`);
      log('Complete your personal details and payment to finish the booking.');
      shared.booked = true;
      return true;
    }

    const { title: dialogTitle, body: dialogBody } = dialogInfo;

    if (dialogBody.includes('Prior to your visit')) {
      log(`${tag} Attempt ${attempt}: "Prior to your visit" — clicking Acknowledge…`);
      const acknowledged = await page.evaluate(() => {
        const btn = document.querySelector('#confirmButton');
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (!acknowledged) {
        await page.keyboard.press('Escape');
        log(`${tag} WARNING: #confirmButton not found — sent Escape.`);
      }
      log(`\n✅  ${tag} SUCCESS on attempt ${attempt}!`);
      log('Complete your personal details and payment to finish the booking.');
      shared.booked = true;
      return true;
    }

    const isNotYetAllowed =
      dialogBody.includes('not yet allowed') ||
      dialogBody.includes('cannot be reserved until');
    const isCannotReserve =
      dialogTitle.includes('Cannot Reserve') ||
      dialogBody.includes('Cannot Reserve');

    if (isNotYetAllowed || isCannotReserve) {
      const closed = await page.evaluate(() => {
        const btn = document.querySelector('#closeButton');
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (!closed) await page.keyboard.press('Escape');
      await sleep(300);
      continue;
    }

    if (dialogBody.includes('cookies')) {
      await page.evaluate(() => {
        const c = document.querySelector('mat-dialog-container');
        const btn = c && c.querySelector('button');
        if (btn) btn.click();
      });
      await sleep(300);
      continue;
    }

    log(`${tag} Attempt ${attempt}: Unexpected dialog: "${dialogBody.trim().slice(0, 120)}"`);
    log('Browser left open — complete the booking manually.');
    shared.booked = true;
    return true;
  }

  if (!shared.booked) {
    log(`${tag} All ${CONFIG.maxRetryAttempts} attempts exhausted.`);
  }
  return false;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function bookCampsite() {
  const runNow = process.argv.includes('--now');
  const debugMode = process.argv.includes('--debug');
  const loginStartTime = runNow ? null : getLoginStartTime();

  const openTimeStr = CONFIG.bookingOpenTime.toLocaleString();
  const secsUntilOpen = Math.round((CONFIG.bookingOpenTime.getTime() - Date.now()) / 1000);
  const minsUntilOpen = Math.round(secsUntilOpen / 60);
  log('Ontario Parks Campsite Auto-Booker starting…');
  log(`Sites (priority order): ${CONFIG.sites.map((s) => s.label).join(' → ')}`);
  log(`Booking opens         : ${openTimeStr}`);
  log(`Check-in date         : ${BOOKING_START_DATE}  →  Check-out: ${BOOKING_END_DATE}  (${BOOKING_NIGHTS} night${BOOKING_NIGHTS !== 1 ? 's' : ''})`);
  if (secsUntilOpen > 0) {
    log(`⏳  Booking starts in  : ${minsUntilOpen >= 2 ? `~${minsUntilOpen} minutes` : `~${secsUntilOpen} seconds`}`);
  } else {
    log('⏳  Booking window is already open — starting immediately.');
  }
  log(`Max attempts per site : ${CONFIG.maxRetryAttempts}`);
  log(`Login starts at       : T-${CONFIG.preLoginSecondsBefore}s (${new Date(CONFIG.bookingOpenTime.getTime() - CONFIG.preLoginSecondsBefore * 1000).toLocaleTimeString()})`);
  log(`Page reloads at       : T-${CONFIG.preReloadSecondsBefore}s (${new Date(CONFIG.bookingOpenTime.getTime() - CONFIG.preReloadSecondsBefore * 1000).toLocaleTimeString()})`);
  log(`Pass --sites ${CONFIG.sites.map((s) => s.label).join(',')} to change priority  |  --attempts N to change retries`);

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

  // ── Login → wait → reload → wait for 7:00 AM → final reload ─────────────
  if (loginStartTime) {
    if (Date.now() < loginStartTime.getTime()) {
      log(`Waiting to start login (T-${CONFIG.preLoginSecondsBefore}s before booking opens)…`);
      await waitUntil(loginStartTime.getTime());
    }

    await performLogin(page);

    // Wait until PRE_RELOAD_SECONDS before 7:00 AM, then reload with fresh searchTime
    const reloadMs = CONFIG.bookingOpenTime.getTime() - CONFIG.preReloadSecondsBefore * 1000;
    if (Date.now() < reloadMs) {
      log(`Waiting to reload page (T-${CONFIG.preReloadSecondsBefore}s before booking opens)…`);
      await waitUntil(reloadMs);
    }
    log('Pre-loading booking page — site tabs will handle the rest…');
    await page.goto(buildUrl(), { waitUntil: 'networkidle', timeout: CONFIG.mapRenderTimeout });
    await dismissCookieBanner(page);
    // Site tabs open next and navigate independently, waiting until bookingOpenTime internally
  } else if (runNow) {
    // --now mode: login immediately, site tabs will waitUntil(bookingOpenTime) internally
    await performLogin(page);
  } else {
    // Already past the login start time — login now, then still wait for bookingOpenTime
    log('Past login start time — logging in now and waiting for booking window…');
    await performLogin(page);

    const reloadMs = CONFIG.bookingOpenTime.getTime() - CONFIG.preReloadSecondsBefore * 1000;
    if (Date.now() < reloadMs) {
      log(`Waiting to pre-load site tabs (T-${CONFIG.preReloadSecondsBefore}s before booking opens)…`);
      await waitUntil(reloadMs);
    }
    log('Pre-loading booking page — site tabs will handle the rest…');
    await page.goto(buildUrl(), { waitUntil: 'networkidle', timeout: CONFIG.mapRenderTimeout });
    await dismissCookieBanner(page);
    // Site tabs open next and navigate independently, waiting until bookingOpenTime internally
  }

  log('Pre-load phase complete — opening site tabs…');


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

  // ── Try each site in order — first available wins ──────────────────────
  const shared = { booked: false };
  const sitePage = await browserContext.newPage();

  for (const site of CONFIG.sites) {
    if (shared.booked) break;
    log(`\n── Trying Site ${site.label} ──`);
    await bookSiteOnPage(sitePage, site, shared);
    if (!shared.booked) {
      log(`Site ${site.label} not booked — trying next site…`);
    }
  }

  if (!shared.booked) {
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

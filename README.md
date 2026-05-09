# Ontario Parks Campsite Auto-Booker

Automates campsite reservations on [Ontario Parks](https://reservations.ontarioparks.ca) the moment the 7:00 AM booking window opens — exactly 5 months before your desired start date.

---

## Requirements

- [Node.js](https://nodejs.org) v18+
- Google Chrome installed at `/Applications/Google Chrome.app`

```bash
npm install
npx playwright install chromium
```

---

## Configuration

### Start Date and End Date

Open `book-campsite.js` and update the two constants at the top:

```javascript
const BOOKING_START_DATE = '2026-10-08'; // YYYY-MM-DD — your check-in date
const BOOKING_END_DATE   = '2026-10-09'; // YYYY-MM-DD — your check-out date
```

`nights` is computed automatically from the difference — you do **not** need to set it manually.

**Booking window rule**: Ontario Parks opens reservations at **7:00 AM exactly 5 months before the start date**. The script computes this automatically — no manual adjustment needed.

| Start Date   | Booking Opens       |
|--------------|---------------------|
| Oct 8, 2026  | May 8, 2026 @ 7:00 AM  |
| Oct 9, 2026  | May 9, 2026 @ 7:00 AM  |
| Jul 1, 2026  | Feb 1, 2026 @ 7:00 AM  |

### Default Campsite Priority

Edit the `defaultSites` array in `book-campsite.js` to set which sites to try and in what order:

```javascript
const defaultSites = ['228', '191', '189'];
```

The script tries site 228 first, then 191, then 189 if earlier ones fail.

---

## Running the Script

### Wait for the booking window (recommended)

```bash
node book-campsite.js
```

The script wakes up 60 seconds before 7:00 AM, pre-loads the map, then hammers the Reserve button the moment the window opens.

### Override the campsite list

```bash
node book-campsite.js --sites 228,201,210
```

Sites are tried in the order you supply. The first available site wins.

### Change the number of retry attempts

```bash
node book-campsite.js --attempts 50
```

Default is 200 attempts (~60 seconds of retrying at ~300 ms each).

### Run immediately (skip the wait)

Useful for testing or if you're already past 7:00 AM:

```bash
node book-campsite.js --now
```

### Combine flags

```bash
node book-campsite.js --sites 228,191,189 --attempts 300
node book-campsite.js --now --sites 228
node book-campsite.js --now --attempts 10
```

### Debug mode (inspect DOM selectors)

Loads the page and dumps map element info without attempting to book:

```bash
node book-campsite.js --now --debug
```

---

## Using an Existing Chrome Window

By default the script launches a new Chrome window. To reuse an already-open Chrome window (opens a new tab instead), start Chrome once with remote debugging enabled:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

After that, every `node book-campsite.js` run will connect to the existing window and open a new tab. Your other tabs are unaffected.

If Chrome is not running with port 9222, the script automatically falls back to launching a new Chrome window.

---

## How It Works

1. **Waits** until T-60s before the booking window opens, then pre-loads the map.
2. **Reloads** with a fresh `searchTime` at exactly 7:00 AM.
3. **Clicks** the campsite marker on the Leaflet map.
4. **Verifies** the sidebar shows the correct site.
5. **Clicks Reserve** repeatedly, handling all popups automatically:
   - `Cannot Reserve` / `not yet allowed` → closes popup, retries
   - `Prior to your visit` → clicks Acknowledge → **booking complete**
   - Cookie consent → dismissed automatically
6. **Falls back** to the next site in the list if all attempts are exhausted.
7. **Leaves the browser open** so you can complete your personal details and payment.

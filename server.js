import express from 'express';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

const app = express();
const PORT = 5002;
const UPTIME_FILE = './uptime.json';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Tracking variables ---
let isOnline = null;
let lastOnlineTime = null;
let downStartTime = null;
let lastCheck = null;
let lastHttpStatus = null;

// Uptime tracking
let uptimeSeconds = 0;
let downtimeSeconds = 0;
// lastStateChange should record when the status actually flipped
let lastStateChange = null;
let lastStatus = null;

// internal clock used for accumulating uptime/downtime in seconds (ms based)
let lastUpdatedAt = Date.now(); // milliseconds

// --- Helpers ---
function nowMs() {
  return Date.now();
}

// Round up to next 30-second mark
function roundUpToNext30Seconds(date = new Date()) {
  const rounded = new Date(date);
  const seconds = rounded.getSeconds();

  if (seconds < 30) {
    rounded.setSeconds(30, 0);
  } else {
    rounded.setMinutes(rounded.getMinutes() + 1, 0, 0);
  }

  return rounded;
}

// Round up to next 5-minute mark
function roundUpToNext5Minutes(date = new Date()) {
  const rounded = new Date(date);
  const minutes = rounded.getMinutes();
  const remainder = minutes % 5;
  const extra = remainder === 0 ? 5 : 5 - remainder;
  rounded.setMinutes(minutes + extra);
  rounded.setSeconds(0);
  rounded.setMilliseconds(0);
  return rounded;
}

// --- Persistence ---
async function loadUptimeFromDisk() {
  try {
    const raw = await fs.readFile(UPTIME_FILE, 'utf8');
    const data = JSON.parse(raw);

    uptimeSeconds = Number(data.uptimeSeconds) || 0;
    downtimeSeconds = Number(data.downtimeSeconds) || 0;
    lastStateChange = data.lastStateChange ? new Date(data.lastStateChange) : null;
    lastStatus = typeof data.lastStatus === 'boolean' ? data.lastStatus : null;
    lastOnlineTime = data.lastOnlineTime ? new Date(data.lastOnlineTime) : null;

    // If server is online, has had downtime, and lastOnlineTime is missing, infer it from lastStateChange
    if (lastStatus === true && downtimeSeconds > 0 && !lastOnlineTime && lastStateChange) {
      lastOnlineTime = lastStateChange;
    }

    // Sanity-check loaded values: if uptimeSeconds looks like milliseconds (very large),
    // convert to seconds. (We're conservative: treat > 10 years as suspicious.)
    const TEN_YEARS_SEC = 10 * 365 * 24 * 3600; // roughly
    if (uptimeSeconds > TEN_YEARS_SEC * 1000) {
      console.warn(`⚠️ uptimeSeconds looks too large (${uptimeSeconds}). Assuming milliseconds were stored — converting to seconds.`);
      uptimeSeconds = Math.floor(uptimeSeconds / 1000);
    } else if (uptimeSeconds > TEN_YEARS_SEC) {
      // suspicious but smaller than ms-threshold; log but keep
      console.warn(`⚠️ uptimeSeconds is very large (${uptimeSeconds} seconds). If this looks wrong, consider editing ${UPTIME_FILE}.`);
    }

    if (downtimeSeconds > TEN_YEARS_SEC * 1000) {
      console.warn(`⚠️ downtimeSeconds looks too large (${downtimeSeconds}). Assuming milliseconds were stored — converting to seconds.`);
      downtimeSeconds = Math.floor(downtimeSeconds / 1000);
    } else if (downtimeSeconds > TEN_YEARS_SEC) {
      console.warn(`⚠️ downtimeSeconds is very large (${downtimeSeconds} seconds). If this looks wrong, consider editing ${UPTIME_FILE}.`);
    }

    lastUpdatedAt = nowMs();
    console.log('✅ Loaded uptime from disk');
  } catch (err) {
    // File missing or JSON invalid -> start fresh
    uptimeSeconds = 0;
    downtimeSeconds = 0;
    lastStateChange = null;
    lastStatus = null;
    lastUpdatedAt = nowMs();
    console.log('📁 No existing uptime.json file found, starting fresh.');
  }
}

async function saveUptimeToDisk() {
  const data = {
    uptimeSeconds,
    downtimeSeconds,
    lastStateChange: lastStateChange ? lastStateChange.toISOString() : null,
    lastStatus,
    lastOnlineTime: lastOnlineTime ? lastOnlineTime.toISOString() : null
  };

  try {
    await fs.writeFile(UPTIME_FILE, JSON.stringify(data, null, 2), 'utf8');
    // console.log('💾 Saved uptime to disk');
  } catch (err) {
    console.error('❌ Failed to save uptime.json:', err);
  }
}

// --- Uptime accounting ---
// Update uptime/downtime counters using lastUpdatedAt (ms) for robust, consistent updates.
// This ensures we always add whole seconds and avoid accidentally adding milliseconds as seconds.
function updateUptimeTracker() {
  const now = nowMs();

  // If we don't have a lastStatus yet, set lastUpdatedAt and return (nothing to count yet)
  if (lastStatus === null) {
    lastUpdatedAt = now;
    return;
  }

  const deltaMs = now - lastUpdatedAt;
  if (deltaMs < 1000) {
    // less than one second has passed; nothing to add, but update lastUpdatedAt so we don't later
    // double count small intervals
    lastUpdatedAt = now;
    return;
  }

  // add whole seconds only
  const deltaSec = Math.floor(deltaMs / 1000);

  if (lastStatus === true) {
    uptimeSeconds += deltaSec;
  } else {
    downtimeSeconds += deltaSec;
  }

  // advance lastUpdatedAt by the seconds we consumed (avoid drift)
  lastUpdatedAt += deltaSec * 1000;
}

// --- Health check ---
async function checkStatus() {
  // First, account for time that passed since last update
  updateUptimeTracker();

  let newStatus = null;

  try {
    // don't use mode: 'no-cors' here — we want the HTTP status
    const res = await fetch('https://rulekeeper.cc', { method: 'GET' });

    if (!res.ok) {
      lastHttpStatus = res.status;
      // treat any non-2xx as offline
      newStatus = false;
    } else {
      lastHttpStatus = res.status;
      newStatus = true;
    }
  } catch (err) {
    // node-fetch throws on network errors / timeouts
    lastHttpStatus = err && err.name ? err.name : 'network_error';
    newStatus = false;
  }

  // Only update lastStateChange on an actual state flip
  if (newStatus !== lastStatus) {
    const flipTime = new Date();
    lastStateChange = flipTime;

    if (newStatus === true) {
      lastOnlineTime = flipTime;
      downStartTime = null;
    } else {
      downStartTime = flipTime;
    }
  }

  // persist state values
  isOnline = newStatus;
  lastStatus = newStatus;
  lastCheck = new Date();

  // Ensure lastUpdatedAt is fresh (so next delta is time from now)
  lastUpdatedAt = nowMs();

  console.log(
    `🔍 Checked at ${lastCheck.toISOString()} - Status: ${isOnline ? 'ONLINE' : 'OFFLINE'} (HTTP: ${lastHttpStatus})`
  );
}

// --- Startup sequence ---
await loadUptimeFromDisk();

// Schedule checks aligned to 5-minute marks (no drift)
async function scheduleNextCheck() {
  await checkStatus();

  const now = new Date();
  const next = roundUpToNext5Minutes(now);
  const delay = next.getTime() - now.getTime();

  setTimeout(scheduleNextCheck, delay);
}

const first = roundUpToNext5Minutes();
setTimeout(scheduleNextCheck, first.getTime() - Date.now());

// Save to disk every 60 seconds
setInterval(saveUptimeToDisk, 60 * 1000);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// --- Endpoints ---
app.get('/status', (req, res) => {
  const next = lastCheck ? roundUpToNext5Minutes(lastCheck) : roundUpToNext5Minutes();
  res.json({
    isOnline,
    lastOnlineTime: lastOnlineTime ? lastOnlineTime.toISOString() : null,
    downStartTime: downStartTime ? downStartTime.toISOString() : null,
    nextCheck: next.toISOString(),
    lastCheck: lastCheck ? lastCheck.toISOString() : null,
    now: new Date().toISOString(),
    lastHttpStatus
  });
});

app.get('/uptime', (req, res) => {
  // ensure latest time is counted before producing numbers
  updateUptimeTracker();

  const total = uptimeSeconds + downtimeSeconds;
  const rawPct = total > 0 ? (uptimeSeconds / total) * 100 : 100;
  const pct2 = rawPct.toFixed(2);      // legacy 2-decimal display
  const pct6 = rawPct.toFixed(6);      // higher precision so "100.00" confusion goes away

  res.json({
    uptimeSeconds,
    downtimeSeconds,
    uptimePercentage: pct2,        // "100.00" previously
    uptimePercentageExact: pct6,  // useful to see precision, e.g. "99.999778"
    nextRefresh: roundUpToNext30Seconds().toISOString(),
    lastStateChange: lastStateChange ? lastStateChange.toISOString() : null,
    lastState: lastStatus === true ? 'ONLINE' : lastStatus === false ? 'OFFLINE' : 'UNKNOWN'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 RuleKeeper status server running at http://localhost:${PORT}`);
});

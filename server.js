import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';
import Database from 'better-sqlite3';
import webpush from 'web-push';
import cron from 'node-cron';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3002;

const API_BASE = 'https://refusecalendarapi.denbighshire.gov.uk';
const POSTCODE = process.env.POSTCODE;
if (!POSTCODE) { console.error('POSTCODE env var required'); process.exit(1); }

webpush.setVapidDetails(
  `mailto:${process.env.VAPID_CONTACT_EMAIL}`,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const dataDir = join(__dirname, 'data');
mkdirSync(dataDir, { recursive: true });
const db = new Database(join(dataDir, 'bins.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS subscribers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    house_number TEXT NOT NULL,
    uprn         TEXT NOT NULL,
    subscription TEXT NOT NULL UNIQUE,
    created_at   TEXT DEFAULT (datetime('now'))
  )
`);

// Cache the estate address list (house number → UPRN). Loaded once at startup.
let uprnMap = {};

async function getCsrfToken() {
  const res = await fetch(`${API_BASE}/Csrf/token`, {
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' }
  });
  if (!res.ok) throw new Error(`Token fetch failed: ${res.status}`);
  const { token } = await res.json();
  return token;
}

async function loadUprnMap() {
  const token = await getCsrfToken();
  const res = await fetch(`${API_BASE}/Calendar/addresses/${POSTCODE}`, {
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-CSRF-TOKEN': token,
      'Referer': `${API_BASE}/`,
      'Origin': API_BASE,
      'User-Agent': 'Mozilla/5.0'
    }
  });
  if (!res.ok) throw new Error(`Address lookup failed: ${res.status}`);
  const list = await res.json(); // [{ uprn, address: "21,TREM Y GRUG,DENBIGHSHIRE" }]
  uprnMap = {};
  for (const item of list) {
    const houseNum = item.address.split(',')[0].trim();
    uprnMap[houseNum] = item.uprn;
  }
  console.log(`Loaded ${Object.keys(uprnMap).length} addresses for ${POSTCODE}`);
}

// Per-UPRN bin data cache (1 hour TTL)
const binCache = {}; // { uprn: { data, expiry } }

async function fetchBinData(uprn) {
  const now = Date.now();
  if (binCache[uprn] && now < binCache[uprn].expiry) return binCache[uprn].data;

  const token = await getCsrfToken();
  const res = await fetch(`${API_BASE}/Calendar/${uprn}`, {
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-CSRF-TOKEN': token,
      'Referer': `${API_BASE}/`,
      'Origin': API_BASE,
      'User-Agent': 'Mozilla/5.0'
    }
  });
  if (!res.ok) throw new Error(`Calendar fetch failed: ${res.status}`);
  const data = await res.json();
  binCache[uprn] = { data, expiry: now + 60 * 60 * 1000 };
  return data;
}

function tomorrowString() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
}

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// Resolve house number → UPRN, return 404 if unknown
app.get('/api/uprn/:houseNumber', (req, res) => {
  const uprn = uprnMap[req.params.houseNumber];
  if (!uprn) return res.status(404).json({ error: `House ${req.params.houseNumber} not found on ${POSTCODE}` });
  res.json({ uprn });
});

app.get('/api/bins/:houseNumber', async (req, res) => {
  const uprn = uprnMap[req.params.houseNumber];
  if (!uprn) return res.status(404).json({ error: `House ${req.params.houseNumber} not found on ${POSTCODE}` });
  try {
    const data = await fetchBinData(uprn);
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(data);
  } catch (err) {
    console.error('Bins API error:', err.message);
    res.status(502).json({ error: 'Could not reach bin collection service. Try again later.' });
  }
});

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY });
});

app.post('/api/subscribe', (req, res) => {
  const { subscription, houseNumber } = req.body;
  if (!subscription || !houseNumber) {
    return res.status(400).json({ error: 'Missing subscription or houseNumber' });
  }
  const uprn = uprnMap[String(houseNumber)];
  if (!uprn) return res.status(404).json({ error: 'House number not found' });
  try {
    db.prepare(`
      INSERT OR REPLACE INTO subscribers (house_number, uprn, subscription)
      VALUES (?, ?, ?)
    `).run(String(houseNumber), uprn, JSON.stringify(subscription));
    res.json({ ok: true });
  } catch (err) {
    console.error('Subscribe error:', err.message);
    res.status(500).json({ error: 'Could not save subscription' });
  }
});

// Manual test push — protected by admin secret
app.post('/api/test-push', async (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  await sendDailyPush(true);
  res.json({ ok: true });
});

app.get('/:houseNumber(\\d+)', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'app.html'));
});

async function sendDailyPush(force = false) {
  const tmr = tomorrowString();

  // Group subscribers by UPRN so we fetch each once
  const rows = db.prepare('SELECT * FROM subscribers').all();
  const byUprn = {};
  for (const row of rows) {
    (byUprn[row.uprn] = byUprn[row.uprn] || []).push(row);
  }

  for (const [uprn, subs] of Object.entries(byUprn)) {
    try {
      const data = await fetchBinData(uprn);
      const bins = [];
      if (data.refuseDate === tmr)                       bins.push('🗑️ General Waste');
      if (data.recyclingDate === tmr)                    bins.push('♻️ Recycling');
      if (data.gardenDate && data.gardenDate === tmr)    bins.push('🌿 Garden Waste');

      if (bins.length === 0 && !force) continue;

      const d = new Date(); d.setDate(d.getDate() + 1);
      const dayName = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
      const binList = bins.length ? bins.join(' + ') : 'nothing (this is a test push!)';
      const houseNum = subs[0].house_number;

      const payload = JSON.stringify({
        title: "🚨 WHERE'S YA BIN?!",
        body: `Tomorrow (${dayName}) — ${binList} — make sure your bins are out by 6:30am. Don't say I never tell ya! 💚`,
        url: `/${houseNum}`
      });

      for (const row of subs) {
        try {
          await webpush.sendNotification(JSON.parse(row.subscription), payload);
        } catch (err) {
          if (err.statusCode === 410) {
            db.prepare('DELETE FROM subscribers WHERE id = ?').run(row.id);
          } else {
            console.error(`Push failed for sub ${row.id}:`, err.message);
          }
        }
      }
      console.log(`UPRN ${uprn}: pushed "${binList}" to ${subs.length} subscriber(s).`);
    } catch (err) {
      console.error(`Push error for UPRN ${uprn}:`, err.message);
    }
  }
}

cron.schedule('0 17 * * *', () => sendDailyPush(), { timezone: 'Europe/London' });

// Load address map before accepting requests
loadUprnMap()
  .then(() => app.listen(PORT, () => console.log(`🗑️  Where's Ya Bin? running on port ${PORT}`)))
  .catch(err => { console.error('Fatal: could not load address map:', err.message); process.exit(1); });

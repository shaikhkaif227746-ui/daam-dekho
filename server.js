import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  parseHtml, cleanTitle, slugTitle, searchQuery, productKey, pickOffers,
  affiliateUrl, isPrivateIp, storeName, shortQuery
} from './lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- config (.env) ----------
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch { /* .env nahi hai, theek hai */ }

let rules = {};
try { rules = JSON.parse(process.env.AFFILIATE_RULES || '{}'); } catch { console.warn('AFFILIATE_RULES valid JSON nahi hai, ignore kiya.'); }
export const cfg = {
  port: Number(process.env.PORT) || 3000,
  serpKey: process.env.SERPAPI_KEY || '',
  amazonTag: process.env.AFFILIATE_AMAZON_TAG || '',
  flipkartId: process.env.AFFILIATE_FLIPKART_ID || '',
  rules,
  cacheMs: (Number(process.env.CACHE_MINUTES) || 60) * 60e3,
  refreshMs: (Number(process.env.REFRESH_HOURS) || 24) * 3600e3,
  trustProxy: process.env.TRUST_PROXY === '1',
  dbPath: process.env.DB_PATH || path.join(__dirname, 'data.db')
};
const DEMO = !cfg.serpKey;

// ---------- database ----------
const db = new DatabaseSync(cfg.dbPath);
db.exec(`
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, key TEXT UNIQUE, title TEXT, created_at INTEGER, last_checked INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS offers(id INTEGER PRIMARY KEY, product_id INTEGER, store TEXT, url TEXT, price REAL, title TEXT, checked_at INTEGER, UNIQUE(product_id, store));
CREATE TABLE IF NOT EXISTS prices(product_id INTEGER, store TEXT, day TEXT, price REAL, PRIMARY KEY(product_id, store, day));
CREATE TABLE IF NOT EXISTS clicks(id INTEGER PRIMARY KEY, offer_id INTEGER, at INTEGER);
`);

// ---------- safe fetch (SSRF se bachav) ----------
class UserError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function assertPublic(host) {
  if (net.isIP(host)) { if (isPrivateIp(host)) throw new UserError('Ye link allowed nahi hai.'); return; }
  const addrs = await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new UserError('Ye link allowed nahi hai.');
}
async function safeFetch(start) {
  let u = start;
  for (let hop = 0; hop < 5; hop++) {
    const url = new URL(u);
    if (!/^https?:$/.test(url.protocol)) throw new UserError('Sirf http/https link chalega.');
    await assertPublic(url.hostname);
    const res = await fetch(url, {
      redirect: 'manual', signal: AbortSignal.timeout(8000),
      headers: { 'user-agent': UA, 'accept-language': 'en-IN,en;q=0.9', accept: 'text/html,application/xhtml+xml' }
    });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) { u = new URL(loc, url).href; continue; }
    return { res, finalUrl: url.href };
  }
  throw new Error('Bahut zyada redirects.');
}

// ---------- link se product ----------
async function inspectUrl(url) {
  let finalUrl = url, parsed = { title: null, price: null }, warning = '';
  try {
    const { res, finalUrl: f } = await safeFetch(url);
    finalUrl = f;
    const html = res.ok ? (await res.text()).slice(0, 1_500_000) : '';
    const blocked = !res.ok || /robot check|access denied|just a moment|captcha/i.test(html.slice(0, 4000));
    if (!blocked) parsed = parseHtml(html);
  } catch (e) {
    if (e instanceof UserError) throw e;
  }
  let title = parsed.title ? cleanTitle(parsed.title) : null;
  if (!title) {
    title = slugTitle(finalUrl) || slugTitle(url);
    if (title) warning = 'Store ne page nahi dikhaya, isliye naam link se nikala gaya. Galat lage to product ka naam likh kar dekho.';
  }
  if (!title) throw new UserError('Is link se product ka naam nahi nikla. Product ka naam likh kar try karo.');
  const host = new URL(finalUrl).hostname;
  const source = parsed.price ? { store: storeName(host), price: parsed.price, url: finalUrl, title } : null;
  return { title, source, warning };
}

// ---------- offers ----------
function rngFrom(seed) {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
const DEMO_STORES = [
  ['Amazon.in', q => `https://www.amazon.in/s?k=${encodeURIComponent(q)}`],
  ['Flipkart', q => `https://www.flipkart.com/search?q=${encodeURIComponent(q)}`],
  ['Croma', q => `https://www.croma.com/searchB?q=${encodeURIComponent(q)}`],
  ['Reliance Digital', q => `https://www.reliancedigital.in/search?q=${encodeURIComponent(q)}`],
  ['Vijay Sales', q => `https://www.vijaysales.com/search/${encodeURIComponent(q)}`]
];
function demoOffers(q) {
  const r = rngFrom(hash(q));
  const base = Math.round((3000 + r() * 70000) / 100) * 100 - 1;
  return DEMO_STORES.map(([store, mk]) => ({ store, title: q, price: Math.round(base * (0.94 + r() * 0.12)), url: mk(q) }));
}
async function serpOffers(q) {
  const u = new URL('https://serpapi.com/search.json');
  u.search = new URLSearchParams({ engine: 'google_shopping', q, gl: 'in', hl: 'en', api_key: cfg.serpKey }).toString();
  const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`SerpApi ${r.status}`);
  const j = await r.json();
  if (j.error && !/hasn't returned any results/i.test(j.error)) throw new Error(`SerpApi: ${j.error}`);
  return (j.shopping_results || []).map(i => ({
    store: i.source, title: i.title, price: i.extracted_price, url: i.link || i.product_link
  }));
}

const today = () => new Date().toISOString().slice(0, 10);

function seedDemoHistory(pid, offers) {
  const ins = db.prepare('INSERT OR IGNORE INTO prices(product_id,store,day,price) VALUES(?,?,?,?)');
  for (const o of offers) {
    const r = rngFrom(hash(pid + o.store));
    let lvl = o.price * (1.08 + r() * 0.06);
    for (let age = 60; age >= 1; age--) {
      lvl += (o.price * 1.02 - lvl) * 0.04 + (r() - 0.5) * o.price * 0.012;
      let v = lvl;
      if (age <= 24 && age > 18) v *= 0.88;
      const d = new Date(Date.now() - age * 864e5).toISOString().slice(0, 10);
      ins.run(pid, o.store, d, Math.round(v / 10) * 10);
    }
  }
}

const debugById = new Map();
async function refreshProduct(p, source) {
  const q = searchQuery(p.title);
  let items = DEMO ? demoOffers(q) : await serpOffers(q);
  let offers = DEMO ? items : pickOffers(q, items);
  let found = items.length, usedQuery = q;
  if (!DEMO && offers.length < 2) {
    const q2 = shortQuery(p.title);
    if (q2 && q2 !== q) {
      const items2 = await serpOffers(q2);
      found += items2.length; usedQuery = q2;
      offers = pickOffers(q2, [...items, ...items2]);
    }
  }
  debugById.set(p.id, { query: usedQuery, found, kept: offers.length });
  if (source) {
    offers = offers.filter(o => o.store !== source.store);
    offers.push(source);
  }
  if (!offers.length) return 0;
  const now = Date.now(), day = today();
  const hasPrices = db.prepare('SELECT 1 FROM prices WHERE product_id=? LIMIT 1').get(p.id);
  db.exec('BEGIN');
  try {
    const up = db.prepare(`INSERT INTO offers(product_id,store,url,price,title,checked_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(product_id,store) DO UPDATE SET url=excluded.url, price=excluded.price, title=excluded.title, checked_at=excluded.checked_at`);
    const pr = db.prepare(`INSERT INTO prices(product_id,store,day,price) VALUES(?,?,?,?)
      ON CONFLICT(product_id,store,day) DO UPDATE SET price=excluded.price`);
    for (const o of offers) { up.run(p.id, o.store, o.url, o.price, o.title || p.title, now); pr.run(p.id, o.store, day, o.price); }
    db.prepare('UPDATE products SET last_checked=? WHERE id=?').run(now, p.id);
    if (DEMO && !hasPrices) seedDemoHistory(p.id, offers);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return offers.length;
}

// ---------- API ----------
function view(pid) {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(pid);
  if (!p) return null;
  const rows = db.prepare('SELECT store,day,price FROM prices WHERE product_id=? ORDER BY day').all(pid);
  const history = {}, lows = {};
  let atl = null;
  for (const r of rows) {
    (history[r.store] ||= []).push([r.day, r.price]);
    if (!(lows[r.store] <= r.price)) lows[r.store] = r.price;
    if (!atl || r.price < atl.price) atl = { price: r.price, store: r.store, day: r.day };
  }
  const offers = db.prepare('SELECT id,store,price,checked_at FROM offers WHERE product_id=? ORDER BY price').all(pid)
    .map(o => ({ id: o.id, store: o.store, price: o.price, low: lows[o.store] ?? o.price, checkedAt: o.checked_at, go: `/go/${o.id}` }));
  return { id: p.id, title: p.title, demo: DEMO, lastChecked: p.last_checked, offers, history, allTimeLow: atl };
}

async function lookup(input) {
  input = String(input || '').trim();
  if (input.length < 3) throw new UserError('Product ka link ya naam daalo.');
  if (input.length > 600) throw new UserError('Input bahut lamba hai.');
  let title, source = null, warning = '';
  if (/^https?:\/\//i.test(input) || /^(www\.)?[a-z0-9-]+\.(com|in|co\.in)\//i.test(input)) {
    const info = await inspectUrl(/^https?:/i.test(input) ? input : 'https://' + input);
    ({ title, source, warning } = info);
  } else {
    title = cleanTitle(input) || input;
  }
  const key = productKey(title);
  if (!key) throw new UserError('Product ka naam samajh nahi aaya.');
  let p = db.prepare('SELECT * FROM products WHERE key=?').get(key);
  if (!p) {
    const r = db.prepare('INSERT INTO products(key,title,created_at) VALUES(?,?,?)').run(key, title, Date.now());
    p = db.prepare('SELECT * FROM products WHERE id=?').get(Number(r.lastInsertRowid));
  }
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM offers WHERE product_id=?').get(p.id).c;
  if (Date.now() - p.last_checked > cfg.cacheMs || source || cnt < 2) {
    let n = 0;
    try { n = await refreshProduct(p, source); }
    catch (e) { console.error('refresh fail:', e.message); if (!db.prepare('SELECT 1 FROM offers WHERE product_id=? LIMIT 1').get(p.id)) throw new UserError('Prices laane mein dikkat aayi. Thodi der baad try karo.', 502); }
    if (!n && !db.prepare('SELECT 1 FROM offers WHERE product_id=? LIMIT 1').get(p.id)) {
      throw new UserError('Is product ke liye kisi store par daam nahi mila. Naam thoda chhota ya saaf likh kar try karo.', 404);
    }
  }
  return { ...view(p.id), warning, debug: debugById.get(p.id) || null };
}

// ---------- rate limit ----------
const hits = new Map();
function limited(ip) {
  const now = Date.now(), arr = (hits.get(ip) || []).filter(t => now - t < 60e3);
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < 60e3)) hits.delete(k);
  return arr.length > 15;
}

// ---------- http ----------
const json = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > 4096) { no(new UserError('Request bahut badi hai.')); req.destroy(); } }); req.on('end', () => ok(b)); req.on('error', no); });

const server = http.createServer(async (req, res) => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  const url = new URL(req.url, 'http://x');
  const ip = (cfg.trustProxy && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || '?';
  try {
    if (req.method === 'POST' && url.pathname === '/api/lookup') {
      if (limited(ip)) return json(res, 429, { error: 'Bahut zyada requests. Ek minute ruk kar try karo.' });
      let body; try { body = JSON.parse(await readBody(req)); } catch (e) { if (e instanceof UserError) throw e; throw new UserError('Request galat hai.'); }
      return json(res, 200, await lookup(body.input));
    }
    if (req.method === 'GET' && /^\/api\/product\/\d+$/.test(url.pathname)) {
      const v = view(Number(url.pathname.split('/')[3]));
      return v ? json(res, 200, { ...v, warning: '' }) : json(res, 404, { error: 'Product nahi mila.' });
    }
    if (req.method === 'GET' && url.pathname === '/api/recent') {
      const rows = db.prepare('SELECT id,title FROM products WHERE last_checked>0 ORDER BY last_checked DESC LIMIT 8').all();
      return json(res, 200, { demo: DEMO, items: rows });
    }
    if (req.method === 'GET' && /^\/go\/\d+$/.test(url.pathname)) {
      const id = Number(url.pathname.split('/')[2]);
      const o = db.prepare('SELECT url FROM offers WHERE id=?').get(id);
      if (!o) { res.writeHead(404); return res.end('Not found'); }
      db.prepare('INSERT INTO clicks(offer_id,at) VALUES(?,?)').run(id, Date.now());
      res.writeHead(302, { location: affiliateUrl(o.url, cfg), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      return res.end();
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    if (e instanceof UserError) return json(res, e.status, { error: e.message });
    console.error(e);
    json(res, 500, { error: 'Server mein kuch gadbad hui.' });
  }
});

// ---------- roz ka price check (price history ke liye) ----------
async function refreshLoop() {
  if (DEMO) return;
  const stale = db.prepare('SELECT * FROM products WHERE last_checked < ? ORDER BY last_checked LIMIT 10').all(Date.now() - cfg.refreshMs);
  for (const p of stale) {
    try { await refreshProduct(p, null); } catch (e) { console.error('refresh fail', p.id, e.message); }
    await new Promise(r => setTimeout(r, 2000));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(cfg.port, () => {
    console.log(`Daam Dekho chal raha hai: http://localhost:${cfg.port}`);
    if (DEMO) console.log('DEMO mode: SERPAPI_KEY nahi mili, prices nakli hain. Asli data ke liye .env mein SERPAPI_KEY daalo.');
  });
  setInterval(refreshLoop, 30 * 60e3).unref();
}
export { server };

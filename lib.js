// Pure helper functions (no network, no database) so they can be tested easily.
import net from 'node:net';

const ENTITIES = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' };
export const decodeEntities = s => String(s).replace(/&(amp|quot|#39|#x27|lt|gt|nbsp);/g, m => ENTITIES[m]);

const STORE_NAMES = [
  [/amazon\./, 'Amazon.in'], [/flipkart/, 'Flipkart'], [/croma/, 'Croma'], [/reliance/, 'Reliance Digital'],
  [/myntra/, 'Myntra'], [/tatacliq|tata cliq/, 'Tata CLiQ'], [/vijaysales|vijay sales/, 'Vijay Sales'],
  [/ajio/, 'Ajio'], [/snapdeal/, 'Snapdeal'], [/nykaa/, 'Nykaa'], [/meesho/, 'Meesho'], [/jiomart/, 'JioMart']
];
export function storeName(s) {
  const x = String(s || '').toLowerCase();
  for (const [re, n] of STORE_NAMES) if (re.test(x)) return n;
  return String(s || '').replace(/^www\./i, '').replace(/\.(com|in|co\.in)$/i, '').trim() || 'Unknown';
}

function metaContent(html, prop) {
  const a = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i').exec(html);
  if (a) return a[1];
  const b = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i').exec(html);
  return b ? b[1] : null;
}

// Page se product ka naam aur (agar likha ho to) daam nikalta hai: JSON-LD Product, phir og:title, phir <title>.
export function parseHtml(html) {
  const out = { title: null, price: null };
  const nodes = [];
  const walk = n => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    nodes.push(n);
    if (n['@graph']) walk(n['@graph']);
  };
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(m[1].trim())); } catch { /* ignore bad JSON */ }
  }
  const prod = nodes.find(n => [].concat(n['@type'] || []).some(t => /^Product$/i.test(String(t))));
  if (prod) {
    out.title = prod.name || null;
    let o = prod.offers;
    if (Array.isArray(o)) o = o[0];
    if (o && typeof o === 'object') {
      const p = o.price ?? o.lowPrice ?? o.priceSpecification?.price;
      const n = Number(String(p).replace(/,/g, ''));
      const cur = o.priceCurrency || 'INR';
      if (isFinite(n) && n > 0 && /^INR$/i.test(cur)) out.price = n;
    }
  }
  if (!out.title) out.title = metaContent(html, 'og:title');
  if (!out.title) { const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html); out.title = t ? t[1] : null; }
  out.title = out.title ? decodeEntities(String(out.title)).replace(/\s+/g, ' ').trim() : null;
  return out;
}

export function cleanTitle(t) {
  return String(t || '')
    .replace(/^\s*amazon\.in\s*:\s*/i, '')
    .replace(/^\s*buy\s+/i, '')
    .split(/\s+[|–—]\s+|\s+-\s+(?=(?:buy|online|price|amazon|flipkart|croma|reliance|at |in india|from))/i)[0]
    .replace(/\s*:\s*(amazon\.in|flipkart).*$/i, '')
    .replace(/\s+:\s+[A-Za-z][A-Za-z &,]{2,30}$/, '')
    .replace(/\s*(online\s+)?(at best price|price in india|best price).*$/i, '')
    .replace(/\s+/g, ' ').trim().slice(0, 140);
}

// Page na khule to link ke andar likhe naam se kaam chalao: /Apple-iPhone-15-128-GB/dp/B0...
export function slugTitle(urlStr) {
  let u; try { u = new URL(urlStr); } catch { return null; }
  const segs = u.pathname.split('/').filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch { return s; } });
  const cand = segs.filter(s => /[a-z]/i.test(s) && s.includes('-') && !/^(dp|gp|p|product|itm\w*)$/i.test(s))
    .sort((a, b) => b.length - a.length)[0];
  if (cand) return cand.replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim();
  return u.searchParams.get('q') || u.searchParams.get('k') || null;
}

const STOP = new Set(['buy', 'online', 'with', 'and', 'the', 'for', 'in', 'at', 'of', 'to', 'by', 'from', 'india', 'price']);
export const tokens = s => String(s || '').toLowerCase().replace(/(\d)([a-z])/g, '$1 $2').replace(/([a-z])(\d)/g, '$1 $2').split(/[^a-z0-9]+/).filter(t => t && !STOP.has(t) && (t.length > 1 || /\d/.test(t)));
const COLORS = new Set(['black', 'white', 'blue', 'red', 'green', 'grey', 'gray', 'silver', 'gold', 'pink', 'yellow', 'purple', 'orange', 'brown', 'midnight', 'starlight', 'titanium', 'natural', 'graphite', 'beige', 'cream', 'lavender', 'mint', 'violet', 'teal', 'navy', 'cyan']);
const queryTokens = q => [...new Set(tokens(q))].filter(t => !COLORS.has(t));
export function relevance(query, itemTitle) {
  const q = queryTokens(query).slice(0, 10);
  if (!q.length) return 0;
  const it = new Set(tokens(itemTitle));
  return q.filter(t => it.has(t)).length / q.length;
}
export function searchQuery(title) {
  const t = String(title).replace(/\s+/g, ' ').trim();
  if (t.length <= 100) return t;
  return t.slice(0, 100).replace(/\s+\S*$/, '');
}
// Chhoti search: brand + model + storage, rang aur baaki lamba text hata kar.
export const shortQuery = title => queryTokens(title).slice(0, 6).join(' ');
export const productKey = title => tokens(title).slice(0, 12).join(' ');

const median = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// In shabdon se alag variant ya accessory pehchani jaati hai (Pro Max, case, charger...).
const VARIANT = new Set(['pro', 'max', 'plus', 'ultra', 'mini', 'lite', 'fe', 'case', 'cover', 'protector', 'tempered', 'glass', 'charger', 'cable', 'strap', 'skin', 'guard', 'stand', 'adapter', 'refurbished', 'renewed', 'used']);
function sameProduct(query, itemTitle) {
  const q = new Set(tokens(query)), it = new Set(tokens(itemTitle));
  for (const t of queryTokens(query).slice(0, 6)) if (/^\d+$/.test(t) && !it.has(t)) return false;      // 128, 15, 256 jaise number match hone chahiye
  for (const t of it) if (VARIANT.has(t) && !q.has(t)) return false;        // query me nahi hai to variant nahi chalega
  return true;
}

// Search results me se wahi offers rakho jo sach me same product ke hain, har store ka sabse kam daam.
export function pickOffers(query, items) {
  let good = items.filter(i => i.price > 0 && i.url && relevance(query, i.title) >= 0.5 && sameProduct(query, i.title));
  if (good.length >= 3) { const med = median(good.map(i => i.price)); good = good.filter(i => i.price >= med * 0.45); }
  const best = new Map();
  for (const i of good) {
    const s = storeName(i.store);
    const cur = best.get(s);
    if (!cur || i.price < cur.price) best.set(s, { ...i, store: s });
  }
  return [...best.values()].sort((a, b) => a.price - b.price);
}

export function affiliateUrl(urlStr, cfg) {
  let u; try { u = new URL(urlStr); } catch { return urlStr; }
  const h = u.hostname.replace(/^www\./, '');
  if (/(^|\.)amazon\.in$/.test(h) && cfg.amazonTag) { u.searchParams.set('tag', cfg.amazonTag); return u.href; }
  if (/(^|\.)flipkart\.com$/.test(h) && cfg.flipkartId) { u.searchParams.set('affid', cfg.flipkartId); return u.href; }
  for (const [dom, rule] of Object.entries(cfg.rules || {})) {
    if (h === dom || h.endsWith('.' + dom)) {
      if (rule.template) return rule.template.replace('{url}', encodeURIComponent(u.href));
      if (rule.param) { u.searchParams.set(rule.param, rule.value); return u.href; }
    }
  }
  return u.href;
}

// Server user ke diye link par request bhejta hai, isliye andar ke (private) addresses block karo.
export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const x = ip.toLowerCase();
  if (x.startsWith('::ffff:')) return isPrivateIp(x.slice(7));
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80');
}

/**
 * Buying Inventory — WIP, from Metabase question 36763.
 *
 * GET /api/wip           mapped rows for the WIP table
 * GET /api/wip?raw=1     column names + the first row, to confirm the mapping
 *
 * Column names are matched loosely, so the question's own headers can be in
 * any order. Anything unrecognised is passed through untouched under `extra`,
 * which is what ?raw=1 shows.
 *
 * Needs METABASE_HOST and METABASE_API_KEY.
 */

const HOST = (process.env.METABASE_HOST || '').replace(/\/$/, '');
const KEY = process.env.METABASE_API_KEY || '';
const CARD_ID = Number(process.env.WIP_QUESTION || 36763);

const cache = { at: 0, rows: null, raw: null };
const TTL_MS = 5 * 60 * 1000;

const num = v => {
  const n = parseFloat(String(v == null ? '' : v).replace(/[$,\s]/g, ''));
  return isNaN(n) ? 0 : n;
};
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const digits = s => String(s || '').replace(/\D/g, '');

const KNOWN = [
  'po', 'ponumber', 'purchaseorder',
  'vendor', 'vendorname', 'seller',
  'sport', 'category',
  'cards', 'cardcount', 'totalcards', 'quantity', 'qty',
  'stage', 'status', 'state',
  'cost', 'value', 'estimatedvalue', 'totalvalue',
  'received', 'receiveddate', 'daterecvd', 'datercvd', 'firstreceived',
  'age', 'days', 'daysinprocess', 'businessdays', 'bizdays',
  'tag', 'grade', 'gradingcompany', 'ordernumber', 'orderid'
];

function shape(row) {
  const keys = Object.keys(row);
  const used = new Set();
  const get = (...names) => {
    for (const n of names) {
      const k = keys.find(k => norm(k) === n);
      if (k !== undefined && row[k] !== null && row[k] !== '') { used.add(k); return row[k]; }
    }
    return '';
  };

  const po = String(get('ponumber', 'po', 'purchaseorder') || '').trim();
  const out = {
    po_number: po ? 'PO-' + digits(po) : '',
    po_raw: digits(po),
    vendor: String(get('vendor', 'vendorname', 'seller') || '').trim(),
    sport: String(get('sport', 'category') || '').trim(),
    cards: num(get('cards', 'cardcount', 'totalcards', 'quantity', 'qty')),
    stage: String(get('stage', 'status', 'state') || '').trim(),
    cost: num(get('cost', 'totalvalue', 'estimatedvalue', 'value')),
    received: String(get('daterecvd', 'datercvd', 'receiveddate', 'firstreceived', 'received', 'processedat', 'duedate') || '').trim(),
    age: num(get('daysinprocess', 'businessdays', 'bizdays', 'age', 'days')),
    order_number: String(get('ordernumber', 'orderid') || '').trim(),
    tag: String(get('tag') || '').trim()
  };

  // keep anything the mapping didn't claim, so nothing is silently lost
  const extra = {};
  keys.forEach(k => { if (!used.has(k)) extra[k] = row[k]; });
  out.extra = extra;
  return out;
}

async function load() {
  if (cache.rows && Date.now() - cache.at < TTL_MS) return cache;

  const res = await fetch(`${HOST}/api/card/${CARD_ID}/query/json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': KEY }
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`question ${CARD_ID}: HTTP ${res.status}`);
  if (!Array.isArray(body)) {
    throw new Error(`question ${CARD_ID}: ${body && body.error ? String(body.error).slice(0, 200) : 'unexpected response'}`);
  }

  cache.raw = body.slice(0, 3);
  cache.rows = body.map(shape);
  cache.at = Date.now();
  return cache;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');

  if (!HOST || !KEY) {
    return res.status(200).json({ ok: false, error: 'METABASE_HOST / METABASE_API_KEY not set' });
  }

  try {
    const c = await load();

    if (req.query.raw) {
      const cols = c.raw.length ? Object.keys(c.raw[0]) : [];
      return res.status(200).json({
        ok: true, card: CARD_ID, columns: cols,
        unmapped: c.rows.length ? Object.keys(c.rows[0].extra) : [],
        sample: c.raw
      });
    }

    const q = req.query;
    const rows = c.rows.filter(r =>
      (!q.po || digits(r.po_raw) === digits(q.po)) &&
      (!q.sport || String(r.sport).toLowerCase().includes(String(q.sport).toLowerCase())) &&
      (!q.vendor || String(r.vendor).toLowerCase().includes(String(q.vendor).toLowerCase()))
    );

    // roll up to one entry per PO, with its sport split
    const byPo = {};
    rows.forEach(r => {
      const key = r.po_number || '(no PO)';
      if (!byPo[key]) byPo[key] = { po: key, vendor: r.vendor, cards: 0, cost: 0, stage: r.stage, received: r.received, age: r.age, sports: {} };
      const g = byPo[key];
      g.cards += r.cards || 1;
      g.cost += r.cost;
      if (!g.vendor && r.vendor) g.vendor = r.vendor;
      if (!g.stage && r.stage) g.stage = r.stage;
      if (!g.received && r.received) g.received = r.received;
      if (r.sport) g.sports[r.sport] = (g.sports[r.sport] || 0) + (r.cards || 1);
    });

    const results = Object.values(byPo).map(g => ({
      ...g,
      sports: Object.entries(g.sports).map(([sport, cards]) => ({ sport, cards }))
                    .sort((a, b) => b.cards - a.cards)
    })).sort((a, b) => b.cards - a.cards);

    return res.status(200).json({
      ok: true, generated: new Date(c.at).toISOString(),
      count: results.length, rows: c.rows.length, results
    });

  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message || String(e) });
  }
};

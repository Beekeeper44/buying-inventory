/**
 * Buying Inventory — DOI pack bands, from saved Metabase questions.
 *
 * GET /api/doi                     every configured category
 * GET /api/doi?category=Baseball   just one
 *
 * Each category is one saved question returning:
 *   PACK | LOWER_BAND | CURRENT_INVENTORY | CARDS_KEPT | DOI | DAILY_OUTPUT
 *
 * Configure with env var DOI_QUESTIONS, comma separated:
 *   DOI_QUESTIONS="Marvel:16873,Wrestling:16874"
 *
 * All nine current categories are built in, so nothing needs configuring —
 * the env var is only for adding new ones without a code change.
 *
 * Also needs METABASE_HOST and METABASE_API_KEY.
 */

const HOST = (process.env.METABASE_HOST || '').replace(/\/$/, '');
const KEY = process.env.METABASE_API_KEY || '';

// Known question ids. Anything in DOI_QUESTIONS overrides these.
const QUESTIONS = {
  'Baseball':   16865,
  'Basketball': 16867,
  'Football':   16864,
  'Pokemon':    16866,
  'One Piece':  16870,
  'Hockey':     16871,
  'Soccer':     16869,
  'Yu-Gi-Oh':   16868,
  'Disney':     16872,
  'UFC':        16876,
  'Star Wars':  16878,
  'Hero':       16879      // DC / Marvel
};

function configured() {
  const out = { ...QUESTIONS };
  (process.env.DOI_QUESTIONS || '').split(',').forEach(pair => {
    const i = pair.lastIndexOf(':');
    if (i < 0) return;
    const name = pair.slice(0, i).trim();
    const id = Number(pair.slice(i + 1).trim());
    if (name && id) out[name] = id;
  });
  return out;
}

const cache = new Map();
const TTL_MS = 15 * 60 * 1000;

const num = v => {
  const n = parseFloat(String(v == null ? '' : v).replace(/[$,\s]/g, ''));
  return isNaN(n) ? 0 : n;
};
/** blank is not zero — a missing DOI or output stays null */
const numOrNull = v => {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = parseFloat(String(v).replace(/[$,\s]/g, ''));
  return isNaN(n) ? null : n;
};

/** Run a saved question and map its columns by name, whatever their order. */
async function runCard(id) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;

  const res = await fetch(`${HOST}/api/card/${id}/query/json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': KEY }
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`question ${id}: HTTP ${res.status}`);
  if (!Array.isArray(body)) {
    throw new Error(`question ${id}: ${body && body.error ? String(body.error).slice(0, 200) : 'unexpected response'}`);
  }

  const pick = (row, ...names) => {
    for (const n of names) {
      for (const k of Object.keys(row)) {
        if (k.toLowerCase().replace(/[^a-z]/g, '') === n) return row[k];
      }
    }
    return '';
  };

  const rows = body.map(r => ({
    pack: String(pick(r, 'pack', 'packprice') || '').trim(),
    lower_band: String(pick(r, 'lowerband', 'band', 'priceband') || '').trim(),
    current_inventory: num(pick(r, 'currentinventory', 'inventory')),
    cards_kept: num(pick(r, 'cardskept', 'kept')),
    doi: numOrNull(pick(r, 'doi', 'daysofinventory')),
    daily_output: numOrNull(pick(r, 'dailyoutput', 'output'))
  })).filter(r => r.pack || r.lower_band);

  cache.set(id, { at: Date.now(), rows });
  return rows;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const noStore = () => res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');

  if (!HOST || !KEY) {
    noStore();
    return res.status(200).json({ ok: false, error: 'METABASE_HOST / METABASE_API_KEY not set' });
  }

  const map = configured();
  const wanted = req.query.category
    ? Object.keys(map).filter(k => k.toLowerCase() === String(req.query.category).toLowerCase())
    : Object.keys(map);

  if (!wanted.length) {
    noStore();
    return res.status(200).json({ ok: false, error: 'no matching category', configured: Object.keys(map) });
  }

  const rows = [], problems = [];
  for (const name of wanted) {
    try {
      const got = await runCard(map[name]);
      got.forEach(r => rows.push({ category: name, ...r }));
    } catch (e) {
      problems.push({ category: name, error: e.message });
    }
  }

  if (!rows.length) noStore();
  return res.status(200).json({
    ok: rows.length > 0,
    generated: new Date().toISOString(),
    categories: Object.keys(map),
    rows,
    problems,
    error: rows.length ? undefined : (problems[0] && problems[0].error) || 'no rows returned'
  });
};

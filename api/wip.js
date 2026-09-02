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

const cache = { at: 0, rows: null, raw: null, groups: null };
const TTL_MS = 5 * 60 * 1000;

const num = v => {
  const n = parseFloat(String(v == null ? '' : v).replace(/[$,\s]/g, ''));
  return isNaN(n) ? 0 : n;
};
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const digits = s => String(s || '').replace(/\D/g, '');

/**
 * Question 36763 columns:
 *   PO_NUMBER SPORT BUCKET STAGE CARDS VAULTED
 *   PENDING_SLABBING PENDING_ASSEMBLY PENDING_RELEASE PENDING_GRADING
 *   PENDING_SCAN PENDING_RESCAN PENDING_DATA_ISSUE INBOUND PENDING_BOXING
 *
 * STAGE is authoritative: FG means finished goods — released, so no longer WIP.
 * (The column was called STATUS earlier; both names are accepted.)
 */
const PENDING = ['pending_scan', 'pending_grading', 'pending_slabbing', 'pending_assembly',
                 'pending_release', 'pending_rescan', 'pending_data_issue', 'pending_boxing'];

function shape(row) {
  const keys = Object.keys(row);
  const get = (...names) => {
    for (const n of names) {
      const k = keys.find(k => norm(k) === n);
      if (k !== undefined && row[k] !== null && row[k] !== '') return row[k];
    }
    return '';
  };
  const out = {
    po_raw: digits(get('ponumber', 'po')),
    sport: String(get('sport') || '').trim(),
    bucket: String(get('bucket') || '').trim(),
    status: String(get('stage', 'status') || '').trim(),   // the question renamed STATUS to STAGE
    cards: num(get('cards')),
    vaulted: num(get('vaulted')),
    inbound: num(get('inbound'))
  };
  PENDING.forEach(p => { out[p] = num(get(p.replace(/_/g, ''))); });
  return out;
}

/**
 * One entry per PO *per STATUS* — the question's STATUS column is taken at face
 * value. A PO that is part inbound and part WIP appears under both, with the
 * cards that are actually in each. Nothing is inferred.
 */
function groupByPoStatus(rows) {
  const by = {};
  rows.forEach(r => {
    if (!r.po_raw) return;
    const status = r.status || 'Other';
    const key = r.po_raw + '|' + status;
    if (!by[key]) {
      by[key] = { po: 'PO-' + r.po_raw, po_raw: r.po_raw, status,
                  cards: 0, vaulted: 0, inbound: 0, sports: {}, buckets: {}, pending: {} };
      PENDING.forEach(p => by[key].pending[p] = 0);
    }
    const g = by[key];
    g.cards += r.cards;
    g.vaulted += r.vaulted;
    g.inbound += r.inbound;
    if (r.sport)  g.sports[r.sport]   = (g.sports[r.sport]   || 0) + r.cards;
    if (r.bucket) g.buckets[r.bucket] = (g.buckets[r.bucket] || 0) + r.cards;
    PENDING.forEach(p => g.pending[p] += r[p]);
  });

  return Object.values(by).map(g => ({
    po: g.po, po_raw: g.po_raw,
    status: g.status,
    stage: /^fg$/i.test(g.status) ? 'FG'
         : /^wip$/i.test(g.status) ? 'WIP'
         : /^inbound$/i.test(g.status) ? 'Inbound'
         : g.status,
    cards: g.cards, vaulted: g.vaulted, inbound_cards: g.inbound,
    pending: g.pending,
    pending_total: PENDING.reduce((s, p) => s + g.pending[p], 0),
    sports: Object.entries(g.sports).map(([sport, cards]) => ({ sport, cards }))
                  .sort((a, b) => b.cards - a.cards),
    buckets: Object.entries(g.buckets).map(([tier, cards]) => ({ tier, cards }))
                  .sort((a, b) => b.cards - a.cards)
  })).sort((a, b) => b.cards - a.cards);
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
  cache.groups = groupByPoStatus(cache.rows);
  cache.at = Date.now();
  return cache;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const noStore = () => res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');

  if (!HOST || !KEY) {
    noStore();
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
    let results = c.groups;

    if (q.po)    results = results.filter(r => r.po_raw === digits(q.po));
    if (q.stage)  results = results.filter(r => r.stage.toLowerCase() === String(q.stage).toLowerCase());
    if (q.status) results = results.filter(r => r.status.toLowerCase() === String(q.status).toLowerCase());
    if (q.sport) results = results.filter(r => r.sports.some(s =>
                    s.sport.toLowerCase().includes(String(q.sport).toLowerCase())));

    const byStatus = {};
    results.forEach(r => {
      const k = r.stage;
      if (!byStatus[k]) byStatus[k] = { pos: new Set(), cards: 0 };
      byStatus[k].pos.add(r.po_raw);
      byStatus[k].cards += r.cards;
    });
    const counts = {};
    Object.entries(byStatus).forEach(([k, v]) => counts[k] = { pos: v.pos.size, cards: v.cards });

    return res.status(200).json({
      ok: true, generated: new Date(c.at).toISOString(),
      statuses: Object.keys(counts).sort(),
      counts,
      cards: results.reduce((s, r) => s + r.cards, 0),
      count: results.length, rows: c.rows.length, results
    });

  } catch (e) {
    noStore();
    return res.status(200).json({ ok: false, error: e.message || String(e) });
  }
};

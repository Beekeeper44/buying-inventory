/**
 * Buying Inventory — Warehouse Cards, from Metabase question 4131.
 *
 * GET /api/warehouse
 *   sport, tag, set, player, parallel, company, grade   substring match
 *   cert, ac, po                                        exact match on digits
 *
 * Every filter accepts a LIST — comma, newline, tab or semicolon separated —
 * so a column of cert numbers can be pasted straight in and any row matching
 * any term comes back.
 *   min, max                                            estimated value bounds
 *   minage, maxage                                      EV age in days
 *   limit, offset                                       paging, 100 per page
 *
 * The saved question is run once and cached, then filtered here.
 *
 * Needs METABASE_HOST and METABASE_API_KEY.
 */

const HOST = (process.env.METABASE_HOST || '').replace(/\/$/, '');
const KEY = process.env.METABASE_API_KEY || '';
const CARD_ID = Number(process.env.WAREHOUSE_QUESTION || 4131);

const cache = { at: 0, rows: null };
const TTL_MS = 10 * 60 * 1000;

const num = v => {
  const n = parseFloat(String(v == null ? '' : v).replace(/[$,\s]/g, ''));
  return isNaN(n) ? 0 : n;
};
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
/** blank age is not zero */
const numOrNull = v => {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = parseFloat(String(v).replace(/[$,\s]/g, ''));
  return isNaN(n) ? null : n;
};

function shape(row) {
  const keys = Object.keys(row);
  const get = (...names) => {
    for (const n of names) {
      const k = keys.find(k => norm(k) === n);
      if (k !== undefined && row[k] !== null && row[k] !== '') return row[k];
    }
    return '';
  };
  return {
    po_number:       String(get('ponumber', 'po') || '').trim(),
    tag:             String(get('tag') || '').trim(),
    image:           String(get('frontslabpictureurl', 'frontpictureurl', 'pictureurl', 'imageurl') || '').trim(),
    url:             String(get('url', 'cardurl', 'adminurl', 'link') || '').trim(),
    sport:           String(get('sport', 'category') || '').trim(),
    cert_number:     String(get('certnumber', 'cert') || '').trim(),
    ac_number:       String(get('8acnumber', 'acnumber', 'ac') || '').trim(),
    grading_company: String(get('gradingcompany', 'grader') || '').trim(),
    grade:           String(get('grade') || '').trim(),
    set_name:        String(get('setname', 'set') || '').trim(),
    insert:          String(get('insert', 'insertname') || '').trim(),
    player_name:     String(get('playername', 'player') || '').trim(),
    parallel_name:   String(get('parallelname', 'parallel') || '').trim(),
    parallel_total:  String(get('paralleltotal') || '').trim(),
    estimated_value: num(get('estimatedvalue', 'ev', 'value')),
    ev_age_days:     numOrNull(get('evagedays', 'evage', 'agedays')),
    item_status:     String(get('itemstatus', 'status') || '').trim()
  };
}

async function loadRows() {
  if (cache.rows && Date.now() - cache.at < TTL_MS) return cache.rows;

  const res = await fetch(`${HOST}/api/card/${CARD_ID}/query/json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': KEY }
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`question ${CARD_ID}: HTTP ${res.status}`);
  if (!Array.isArray(body)) {
    throw new Error(`question ${CARD_ID}: ${body && body.error ? String(body.error).slice(0, 200) : 'unexpected response'}`);
  }

  cache.rows = body.map(shape);
  cache.at = Date.now();
  return cache.rows;
}

/** Split a filter value on commas, newlines, tabs or semicolons. */
const terms = v => String(v == null ? '' : v)
  .split(/[,\n\r\t;]+/)
  .map(t => t.trim())
  .filter(Boolean);

/** Match if the field contains ANY of the pasted terms. */
const hasAny = (hay, raw) => {
  const list = terms(raw);
  if (!list.length) return true;
  const h = String(hay || '').toLowerCase();
  return list.some(t => h.includes(t.toLowerCase()));
};

const digits = s => String(s || '').replace(/\D/g, '');

/** Exact match on digits against any pasted term — for cert / AC / PO. */
const digitAny = (hay, raw) => {
  const list = terms(raw).map(digits).filter(Boolean);
  if (!list.length) return true;
  return list.includes(digits(hay));
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const noStore = () => res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');

  if (!HOST || !KEY) {
    noStore();
    return res.status(200).json({ ok: false, error: 'METABASE_HOST / METABASE_API_KEY not set' });
  }

  try {
    const all = await loadRows();
    const q = req.query;

    const rows = all.filter(r =>
      hasAny(r.sport, q.sport) &&
      hasAny(r.tag, q.tag) &&
      hasAny(r.set_name, q.set) &&
      hasAny(r.player_name, q.player) &&
      hasAny(r.parallel_name, q.parallel) &&
      hasAny(r.grading_company, q.company) &&
      hasAny(r.grade, q.grade) &&
      digitAny(r.cert_number, q.cert) &&
      digitAny(r.ac_number, q.ac) &&
      digitAny(r.po_number, q.po) &&
      (!q.min || r.estimated_value >= num(q.min)) &&
      (!q.max || r.estimated_value <= num(q.max)) &&
      (!q.minage || (r.ev_age_days !== null && r.ev_age_days >= num(q.minage))) &&
      (!q.maxage || (r.ev_age_days !== null && r.ev_age_days <= num(q.maxage)))
    );

    // ?facet=player_name&fq=kob → the matching values only, so nothing is cut off
    if (q.facet) {
      const key = String(q.facet);
      if (!['sport','tag','grading_company','grade','set_name','player_name','parallel_name','item_status'].includes(key)) { noStore(); return res.status(200).json({ ok: false, error: 'unknown facet' }); }
      const needle = String(q.fq || '').toLowerCase();
      const seen = new Set();
      all.forEach(r => { const v = r[key]; if (v) seen.add(String(v)); });
      const values = [...seen]
        .filter(v => !needle || v.toLowerCase().includes(needle))
        .sort((a, b) => {
          const A = a.toLowerCase(), B = b.toLowerCase();
          if (needle) {
            const rank = x => x.startsWith(needle) ? 0
              : x.split(/[\s\/]+/).some(w => w.startsWith(needle)) ? 1 : 2;
            const d = rank(A) - rank(B); if (d) return d;
          }
          return A.localeCompare(B);
        })
        .slice(0, 300);
      return res.status(200).json({ ok: true, facet: key, total: seen.size, values });
    }

    const distinct = key => [...new Set(all.map(r => r[key]).filter(Boolean))]
      .sort((a, b) => String(a).localeCompare(String(b)));

    const limit  = Math.min(Number(q.limit) || 100, 1000);
    const offset = Math.max(Number(q.offset) || 0, 0);

    return res.status(200).json({
      ok: true,
      generated: new Date(cache.at).toISOString(),
      total: all.length,
      matched: rows.length,
      value: rows.reduce((s, r) => s + r.estimated_value, 0),
      facets: {
        sport: distinct('sport'),
        tag: distinct('tag'),
        grading_company: distinct('grading_company'),
        grade: distinct('grade'),
        set_name: distinct('set_name').slice(0, 2000),
        player_name: distinct('player_name').slice(0, 2000),
        parallel_name: distinct('parallel_name').slice(0, 2000),
        item_status: distinct('item_status')
      },
      limit, offset,
      pages: Math.max(1, Math.ceil(rows.length / limit)),
      rows: rows
        .sort((a, b) => b.estimated_value - a.estimated_value)
        .slice(offset, offset + limit)
    });

  } catch (e) {
    noStore();
    return res.status(200).json({ ok: false, error: e.message || String(e) });
  }
};

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
 *   limit                                               default 300
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
    url:             String(get('url', 'cardurl', 'adminurl') || '').trim(),
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
    estimated_value: num(get('estimatedvalue', 'ev', 'value'))
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
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');

  if (!HOST || !KEY) {
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
      (!q.max || r.estimated_value <= num(q.max))
    );

    const distinct = key => [...new Set(all.map(r => r[key]).filter(Boolean))]
      .sort((a, b) => String(a).localeCompare(String(b)));

    const limit = Math.min(Number(q.limit) || 300, 3000);

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
        parallel_name: distinct('parallel_name').slice(0, 2000)
      },
      rows: rows
        .sort((a, b) => b.estimated_value - a.estimated_value)
        .slice(0, limit)
    });

  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message || String(e) });
  }
};

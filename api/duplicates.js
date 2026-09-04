/**
 * Buying Inventory — duplicates, from Metabase question 36730.
 *
 * GET /api/duplicates
 *   sport, set, player, parallel, tag, company, grade   substring / exact match
 *   min, max                                            estimated value bounds
 *   limit, offset                                       paging, 100 per page
 *
 * The saved question is run once and cached, then filtered here, so the
 * dropdowns stay instant and Metabase gets one query every 15 minutes
 * instead of one per keystroke.
 *
 * Needs METABASE_HOST and METABASE_API_KEY.
 */

const HOST = (process.env.METABASE_HOST || '').replace(/\/$/, '');
const KEY = process.env.METABASE_API_KEY || '';
const CARD_ID = Number(process.env.DUPLICATES_QUESTION || 36730);

const cache = { at: 0, rows: null };
const TTL_MS = 15 * 60 * 1000;

const num = v => {
  const n = parseFloat(String(v == null ? '' : v).replace(/[$,\s]/g, ''));
  return isNaN(n) ? 0 : n;
};
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Map the question's columns onto stable names, whatever their order. */
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
    url:             String(get('url', 'cardurl', 'adminurl', 'link') || '').trim(),
    image:           String(get('frontslabpictureurl', 'frontpictureurl', 'pictureurl', 'imageurl') || '').trim(),
    year:            String(get('year') || '').trim(),
    set_name:        String(get('setname', 'set') || '').trim(),
    insert:          String(get('insert', 'insertname') || '').trim(),
    player_name:     String(get('playername', 'player') || '').trim(),
    set_number:      String(get('setnumber', 'cardnumber') || '').trim(),
    parallel_name:   String(get('parallelname', 'parallel') || '').trim(),
    parallel_total:  String(get('paralleltotal') || '').trim(),
    grading_company: String(get('gradingcompany', 'grader') || '').trim(),
    grade:           String(get('grade') || '').trim(),
    tag:             String(get('tag') || '').trim(),
    sport:           String(get('sport', 'category') || '').trim(),
    total_duplicates: num(get('totalduplicates', 'duplicates', 'copies')),
    avg_estimated_value: num(get('avgestimatedvalue', 'estimatedvalue', 'avgev')),
    ac_number:       String(get('acnumber', 'ac') || '').trim()
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

const terms = v => String(v == null ? '' : v).split(/[,\n\r\t;]+/).map(t => t.trim()).filter(Boolean);
const has = (hay, raw) => {
  const list = terms(raw);
  if (!list.length) return true;
  const h = String(hay || '').toLowerCase();
  return list.some(t => h.includes(t.toLowerCase()));
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
      has(r.sport, q.sport) &&
      has(r.set_name, q.set) &&
      has(r.player_name, q.player) &&
      has(r.parallel_name, q.parallel) &&
      has(r.tag, q.tag) &&
      has(r.grading_company, q.company) &&
      has(r.grade, q.grade) &&
      (!q.min || r.avg_estimated_value >= num(q.min)) &&
      (!q.max || r.avg_estimated_value <= num(q.max))
    );

    // ?facet=player_name&fq=kob → the matching values only, so nothing is cut off
    if (q.facet) {
      const key = String(q.facet);
      if (!['sport','grading_company','grade','tag','set_name','player_name','parallel_name'].includes(key)) { noStore(); return res.status(200).json({ ok: false, error: 'unknown facet' }); }
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
      copies: rows.reduce((s, r) => s + r.total_duplicates, 0),
      value: rows.reduce((s, r) => s + r.total_duplicates * r.avg_estimated_value, 0),
      facets: {
        sport: distinct('sport'),
        grading_company: distinct('grading_company'),
        grade: distinct('grade'),
        tag: distinct('tag'),
        set_name: distinct('set_name').slice(0, 2000),
        player_name: distinct('player_name').slice(0, 2000),
        parallel_name: distinct('parallel_name').slice(0, 2000)
      },
      limit, offset,
      pages: Math.max(1, Math.ceil(rows.length / limit)),
      rows: rows
        .sort((a, b) => b.total_duplicates - a.total_duplicates)
        .slice(offset, offset + limit)
    });

  } catch (e) {
    noStore();
    return res.status(200).json({ ok: false, error: e.message || String(e) });
  }
};

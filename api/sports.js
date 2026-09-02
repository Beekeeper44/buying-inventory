/**
 * Buying Inventory — sport breakdown by PO, from Metabase (Snowflake).
 *
 * GET /api/sports              every PO in the current series
 * GET /api/sports?po=4222      one PO
 * GET /api/sports?min=3000     change the PO floor (default 3000)
 *
 * Env vars:
 *   METABASE_HOST      e.g. https://arena-club.metabaseapp.com
 *   METABASE_API_KEY   an API key with read access
 *   METABASE_DB_ID     Snowflake database id (default 397)
 *
 * Where the data comes from: admin.orders.purchase_location is written as
 * "po 4150 1-99 pkmn p3" — PO number, price bucket, sport code, priority.
 * That is the only place the sheet's PO number meets warehouse card data,
 * so it is parsed rather than joined. Sport falls back to admin.cards.sport
 * when the code is missing or unrecognised.
 */

const HOST = (process.env.METABASE_HOST || '').replace(/\/$/, '');
const KEY = process.env.METABASE_API_KEY || '';
const DB_ID = Number(process.env.METABASE_DB_ID || 397);

const cache = { at: 0, rows: null };
const TTL_MS = 10 * 60 * 1000;

const SQL = `
WITH o  AS (SELECT * FROM APP_PROD.PUBLIC.ORDERS       WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)),
     ao AS (SELECT * FROM APP_PROD.ADMIN.ORDERS        WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)),
     oi AS (SELECT * FROM APP_PROD.PUBLIC.ORDER_ITEMS  WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)),
     ca AS (SELECT * FROM APP_PROD.ADMIN.CARDS         WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)),
src AS (
  SELECT
    o.id,
    TRY_TO_NUMBER(REGEXP_SUBSTR(ao.purchase_location, 'po\\s*([0-9]{4})(\\s|$)', 1, 1, 'ei', 1)) AS po_number,
    REGEXP_SUBSTR(ao.purchase_location, 'po\\s*[0-9]{4}\\s+(<?[0-9]+[-+]?[0-9]*)', 1, 1, 'ei', 1) AS bucket,
    LOWER(REGEXP_SUBSTR(ao.purchase_location, 'po\\s*[0-9]{4}\\s+\\S+\\s+([a-z]+)', 1, 1, 'ei', 1)) AS code
  FROM o JOIN ao ON ao.id = o.id
  WHERE ao.purchase_location ILIKE 'po %'
)
SELECT
  s.po_number                                                   AS po_number,
  COALESCE(
    DECODE(s.code,'bb','baseball','bk','basketball','fb','football','pkmn','pokemon',
                  'ms','multi sports','hk','hockey','scr','soccer','mar','marvel',
                  'dis','disney','ww','wrestling','strwrs','star wars','ufc','ufc',
                  'gl','grail','spc','special','op','one piece','ygo','yu-gi-oh!'),
    NULLIF(TRIM(LOWER(c.sport)), ''),
    'unspecified')                                              AS sport,
  s.bucket                                                      AS bucket,
  COUNT(*)                                                      AS cards,
  COUNT_IF(c.vaulted_at IS NOT NULL)                            AS released,
  COUNT_IF(c.vaulted_at IS NULL)                                AS not_released,
  COUNT_IF(c.graded_at IS NULL AND c.vaulted_at IS NULL)        AS pending_grading
FROM src s
JOIN oi ON oi.order_id = s.id
JOIN ca c ON c.id = oi.card_id
WHERE s.po_number >= {{min_po}}
  AND c.status <> 'archived'
GROUP BY 1, 2, 3
ORDER BY 1 DESC, cards DESC
`;

async function runQuery(minPo) {
  const res = await fetch(`${HOST}/api/dataset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify({
      type: 'native',
      database: DB_ID,
      native: { query: SQL.replace('{{min_po}}', String(Number(minPo) || 3000)) }
    })
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `Metabase HTTP ${res.status}`);
  if (body.error) throw new Error(String(body.error).slice(0, 300));

  const cols = (body.data?.cols || []).map(c => String(c.name).toLowerCase());
  const idx = n => cols.indexOf(n);
  return (body.data?.rows || []).map(r => ({
    po_number: r[idx('po_number')],
    sport: r[idx('sport')],
    bucket: r[idx('bucket')],
    cards: Number(r[idx('cards')] || 0),
    released: Number(r[idx('released')] || 0),
    not_released: Number(r[idx('not_released')] || 0),
    pending_grading: Number(r[idx('pending_grading')] || 0)
  }));
}

/** Collapse the flat rows into one entry per PO. */
function group(rows) {
  const byPo = {};
  rows.forEach(r => {
    const key = 'PO-' + r.po_number;
    if (!byPo[key]) byPo[key] = { po: key, total: 0, released: 0, not_released: 0, sports: {}, buckets: {} };
    const g = byPo[key];
    g.total += r.cards;
    g.released += r.released;
    g.not_released += r.not_released;
    g.sports[r.sport] = (g.sports[r.sport] || 0) + r.cards;
    if (r.bucket) g.buckets[r.bucket] = (g.buckets[r.bucket] || 0) + r.cards;
  });
  return Object.values(byPo).map(g => ({
    po: g.po, total: g.total, released: g.released, not_released: g.not_released,
    sports: Object.entries(g.sports).map(([sport, cards]) => ({ sport, cards }))
                  .sort((a, b) => b.cards - a.cards),
    buckets: Object.entries(g.buckets).map(([tier, cards]) => ({ tier, cards }))
                  .sort((a, b) => b.cards - a.cards)
  }));
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const noStore = () => res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');

  if (!HOST || !KEY) {
    noStore();
    return res.status(200).json({ ok: false,
      error: 'METABASE_HOST / METABASE_API_KEY not set on this deployment'
    });
  }

  try {
    const { po, min = '3000' } = req.query;

    if (!cache.rows || Date.now() - cache.at > TTL_MS) {
      cache.rows = await runQuery(min);
      cache.at = Date.now();
    }
    const results = group(cache.rows);

    if (po) {
      const want = 'PO-' + String(po).replace(/^PO-/i, '');
      const hit = results.find(r => r.po === want);
      return res.status(200).json(hit
        ? { ok: true, ...hit }
        : { ok: false, error: `no warehouse cards found for ${want}` });
    }

    return res.status(200).json({
      ok: true, generated: new Date().toISOString(), count: results.length, results
    });

  } catch (e) {
    noStore();
    return res.status(200).json({ ok: false, error: e.message || String(e) });
  }
};

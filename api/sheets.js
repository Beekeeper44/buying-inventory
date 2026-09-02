/**
 * Buying Inventory — Google Sheets reader
 *
 * GET /api/sheets?feed=pos                 inbound + WIP from Dashboard & Order List
 * GET /api/sheets?feed=sports&po=4222      sport counts for one PO's buying sheet
 * GET /api/sheets?feed=sports&all=1&limit=20   sport counts for every open PO
 *
 * Env vars (Vercel → Settings → Environment Variables):
 *   GOOGLE_CLIENT_EMAIL   service account address
 *   GOOGLE_PRIVATE_KEY    its private key, newlines as \n
 *   ORDER_LIST_ID         1bg9BZufjr5cXDlKLuRkzOD0KgZbwqzWE0U8Sfwz502U
 *
 * The service account must be able to open the Order List and the buying
 * sheets. Sharing the Drive folder they live in with the service account
 * address covers all of them at once.
 */

const { google } = require('googleapis');

const ORDER_LIST_ID = process.env.ORDER_LIST_ID || '1bg9BZufjr5cXDlKLuRkzOD0KgZbwqzWE0U8Sfwz502U';
const DASH_TAB = 'Dashboard';
const OL_TAB = 'Order List';

// Dashboard column map (0-based) — matches HubCode.gs
const D = {
  po: 0, vendor: 1, cards: 2, tracking: 3, pkgTotal: 4, pkgRcvd: 5, firstRcvd: 6,
  received: 7, rcvdTs: 8, rcvdBy: 9, verified: 10, damage: 13, shipped: 16,
  complete: 19, flag: 23, notes: 24
};
// Order List columns (0-based)
const O = { po: 1, vendor: 2, cost: 4, invoice: 5, link: 7, track: 8, paid: 9, rcvd: 11, proc: 12, cards: 14 };

const NON_SPORT = /^bonus\b/i;
const HAS_SA = () => !!(process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY);
const cache = new Map();                 // survives warm invocations
const TTL_MS = 10 * 60 * 1000;

function client() {
  const key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const auth = new google.auth.JWT(
    process.env.GOOGLE_CLIENT_EMAIL, null, key,
    ['https://www.googleapis.com/auth/spreadsheets.readonly']
  );
  return google.sheets({ version: 'v4', auth });
}

const truthy = v => v === true || /^true$/i.test(String(v || '').trim());
const num = v => {
  const n = parseFloat(String(v == null ? '' : v).replace(/[$,\s]/g, ''));
  return isNaN(n) ? 0 : n;
};
const colName = n => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; } return s; };

/* ---------- public mode: no credentials, reads the shared link ---------- */
const gviz = (id, tab, query) =>
  `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&headers=1` +
  `&sheet=${encodeURIComponent(tab)}` + (query ? `&tq=${encodeURIComponent(query)}` : '');

function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (q && text[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === ',' && !q) { row.push(cur); cur = ''; }
    else if ((c === '\n' || c === '\r') && !q) {
      if (cur !== '' || row.length) { row.push(cur); rows.push(row); row = []; cur = ''; }
      if (c === '\r' && text[i + 1] === '\n') i++;
    } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

async function publicTab(id, tab, query) {
  const res = await fetch(gviz(id, tab, query));
  if (!res.ok) throw new Error(`${tab}: HTTP ${res.status}`);
  const text = await res.text();
  if (/^\s*</.test(text)) throw new Error(`${tab}: not shared — set it to "Anyone with the link"`);
  return parseCsv(text);
}

/** Same shape as posFeed, built from the public CSV export. */
async function posFeedPublic() {
  const [dashRaw, olRaw] = await Promise.all([
    publicTab(ORDER_LIST_ID, DASH_TAB),
    publicTab(ORDER_LIST_ID, OL_TAB)
  ]);
  const dash = dashRaw.slice(1);          // header row consumed by headers=1
  const ol   = olRaw.slice(1);

  const meta = {};
  ol.forEach(r => {
    const po = String(r[O.po] || '').trim();
    if (!po) return;
    meta[po] = {
      cost: num(r[O.cost]) || num(r[O.invoice]),
      paid: String(r[O.paid] || '').toUpperCase().trim() === 'PAID',
      date_proc: String(r[O.proc] || '').trim(),
      ol_cards: num(r[O.cards]),
      sheet_name: String(r[O.link] || '').trim()
    };
  });

  const orders = [];
  for (const row of dash) {
    const po = String(row[D.po] || '').trim();
    if (!po || /^po\b/i.test(po)) continue;
    if (truthy(row[D.complete])) continue;

    const m = meta[po] || {};
    const received = truthy(row[D.received]);
    if (received && (!!m.date_proc || truthy(row[D.verified]))) continue;

    orders.push({
      po_number: 'PO-' + po, po_raw: po,
      vendor: String(row[D.vendor] || '').trim() || '—',
      cost: m.cost || 0, paid: !!m.paid,
      cards: num(row[D.cards]) || m.ol_cards || 0,
      tracking: String(row[D.tracking] || '').trim(),
      sheet_name: m.sheet_name || 'PO ' + po,
      sheet_url: '',                       // link chips are invisible to CSV export
      pkg_total: num(row[D.pkgTotal]), pkg_received: num(row[D.pkgRcvd]),
      date_rcvd: String(row[D.rcvdTs] || row[D.firstRcvd] || '').trim(),
      first_rcvd: String(row[D.firstRcvd] || '').trim(),
      flag: String(row[D.flag] || '').trim(),
      notes: String(row[D.notes] || '').trim(),
      stage: received ? 'WIP' : 'Inbound',
      stage_name: received ? (truthy(row[D.damage]) ? 'Damage logged' : 'In process') : 'Awaiting delivery'
    });
  }
  return orders;
}

/* ---------- column H links (chips, HYPERLINK formulas, plain urls) ---------- */
async function orderListLinks(sheets, lastRow) {
  const res = await sheets.spreadsheets.get({
    spreadsheetId: ORDER_LIST_ID,
    ranges: [`${OL_TAB}!H2:H${lastRow}`],
    fields: 'sheets.data.rowData.values(hyperlink,formattedValue,chipRuns.chip.richLinkProperties.uri,textFormatRuns.format.link.uri)'
  });
  const rows = (res.data.sheets?.[0]?.data?.[0]?.rowData) || [];
  return rows.map(r => {
    const c = r?.values?.[0];
    if (!c) return '';
    const chip = c.chipRuns?.[0]?.chip?.richLinkProperties?.uri;
    if (chip) return chip;
    if (c.hyperlink) return c.hyperlink;
    const run = c.textFormatRuns?.find(t => t.format?.link?.uri);
    if (run) return run.format.link.uri;
    const m = String(c.formattedValue || '').match(/https?:\/\/\S+/);
    return m ? m[0] : '';
  });
}

/* ---------- inbound / WIP ---------- */
async function posFeed(sheets) {
  const got = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: ORDER_LIST_ID,
    ranges: [`${DASH_TAB}!A3:Y`, `${OL_TAB}!A2:O`]
  });
  const dash = got.data.valueRanges[0].values || [];
  const ol = got.data.valueRanges[1].values || [];
  const links = await orderListLinks(sheets, ol.length + 1);

  const meta = {};
  ol.forEach((r, i) => {
    const po = String(r[O.po] || '').trim();
    if (!po) return;
    meta[po] = {
      cost: num(r[O.cost]) || num(r[O.invoice]),
      paid: String(r[O.paid] || '').toUpperCase().trim() === 'PAID',
      date_rcvd: String(r[O.rcvd] || '').trim(),
      date_proc: String(r[O.proc] || '').trim(),
      ol_cards: num(r[O.cards]),
      sheet_name: String(r[O.link] || '').trim(),
      sheet_url: links[i] || ''
    };
  });

  const orders = [];
  for (const row of dash) {
    const po = String(row[D.po] || '').trim();
    if (!po || /^po\b/i.test(po)) continue;
    if (truthy(row[D.complete])) continue;

    const m = meta[po] || {};
    const received = truthy(row[D.received]);
    const processed = !!m.date_proc || truthy(row[D.verified]);
    if (received && processed) continue;             // past WIP

    orders.push({
      po_number: 'PO-' + po,
      po_raw: po,
      vendor: String(row[D.vendor] || '').trim() || '—',
      cost: m.cost || 0,
      paid: !!m.paid,
      cards: num(row[D.cards]) || m.ol_cards || 0,
      tracking: String(row[D.tracking] || '').trim(),
      sheet_name: m.sheet_name || 'PO ' + po,
      sheet_url: m.sheet_url || '',
      pkg_total: num(row[D.pkgTotal]),
      pkg_received: num(row[D.pkgRcvd]),
      date_rcvd: String(row[D.rcvdTs] || row[D.firstRcvd] || m.date_rcvd || '').trim(),
      first_rcvd: String(row[D.firstRcvd] || '').trim(),
      flag: String(row[D.flag] || '').trim(),
      notes: String(row[D.notes] || '').trim(),
      stage: received ? 'WIP' : 'Inbound',
      stage_name: received ? (truthy(row[D.damage]) ? 'Damage logged' : 'In process') : 'Awaiting delivery'
    });
  }
  return orders;
}

/* ---------- sport counts for one buying sheet ---------- */
async function sportsFor(sheets, url) {
  const idm = String(url).match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!idm) return { error: 'not a spreadsheet url' };
  const id = idm[1];

  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.val;

  let val;
  try {
    // 1. header rows only — find every column headed Sport / Character
    const meta = await sheets.spreadsheets.get({ spreadsheetId: id, fields: 'sheets.properties' });
    const first = meta.data.sheets[0].properties;
    const tab = first.title;
    const rows = first.gridProperties.rowCount;

    const head = await sheets.spreadsheets.values.get({
      spreadsheetId: id, range: `${tab}!A1:CZ4`, majorDimension: 'ROWS'
    });
    const grid = head.data.values || [];
    const cols = [];
    grid.forEach(r => r.forEach((cell, i) => {
      if (/^(sport|character)$/i.test(String(cell || '').trim()) && !cols.includes(i + 1)) cols.push(i + 1);
    }));
    if (!cols.length) return { error: 'no "Sport" header in the first 4 rows' };

    // 2. read just those columns
    const ranges = cols.map(c => `${tab}!${colName(c)}1:${colName(c)}${Math.min(rows, 20000)}`);
    const got = await sheets.spreadsheets.values.batchGet({ spreadsheetId: id, ranges, majorDimension: 'COLUMNS' });

    const tally = {};
    let total = 0, bonus = 0;
    (got.data.valueRanges || []).forEach(vr => {
      (vr.values?.[0] || []).forEach(v => {
        const s = String(v || '').trim();
        if (!s || /^(sport|character)$/i.test(s)) return;
        if (NON_SPORT.test(s)) { bonus++; return; }
        tally[s] = (tally[s] || 0) + 1;
        total++;
      });
    });

    val = total
      ? {
          total, bonus,
          columns: cols.map(colName).join(','),
          sports: Object.entries(tally).map(([sport, cards]) => ({ sport, cards }))
                        .sort((a, b) => b.cards - a.cards)
        }
      : { error: `Sport columns ${cols.map(colName).join(',')} are empty` };

  } catch (e) {
    val = { error: (e.errors?.[0]?.message || e.message || String(e)).slice(0, 200) };
  }

  cache.set(id, { at: Date.now(), val });
  return val;
}

/* ---------- handler ---------- */
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  const { feed = 'pos', po, all, limit = '20' } = req.query;

  try {
    // No service account? Fall back to the public link for the master sheet.
    if (!HAS_SA()) {
      if (feed === 'pos') {
        return res.status(200).json({
          ok: true, mode: 'public', generated: new Date().toISOString(),
          orders: await posFeedPublic()
        });
      }
      return res.status(200).json({
        ok: false, mode: 'public',
        error: 'Sport counts need the service account — the buying sheets are private and their column H links are invisible to the public export.'
      });
    }

    const sheets = client();

    if (feed === 'pos') {
      return res.status(200).json({ ok: true, generated: new Date().toISOString(), orders: await posFeed(sheets) });
    }

    if (feed === 'sports') {
      const orders = await posFeed(sheets);

      if (po) {
        const want = String(po).replace(/^PO-/i, '');
        const row = orders.find(o => o.po_raw === want);
        if (!row) return res.status(404).json({ ok: false, error: 'PO not in the open list' });
        if (!row.sheet_url) return res.status(200).json({ ok: true, po: row.po_number, error: 'no sheet link in column H' });
        return res.status(200).json({ ok: true, po: row.po_number, ...(await sportsFor(sheets, row.sheet_url)) });
      }

      if (all) {
        const targets = orders.filter(o => o.sheet_url).slice(0, Number(limit) || 20);
        const out = [];
        for (const o of targets) {
          out.push({ po: o.po_number, ...(await sportsFor(sheets, o.sheet_url)) });
        }
        return res.status(200).json({ ok: true, count: out.length, results: out });
      }

      return res.status(400).json({ ok: false, error: 'pass po=4222 or all=1' });
    }

    return res.status(400).json({ ok: false, error: 'unknown feed' });

  } catch (e) {
    return res.status(500).json({ ok: false, error: e.errors?.[0]?.message || e.message || String(e) });
  }
};

# Buying Inventory — Vercel

Reads the Operations Order List and each PO's buying sheet server-side with a
Google service account. No Apps Script, no browser access to private sheets.

## Deploy in two minutes

    cd buying-inventory
    npx vercel            # follow the prompts, accept the defaults
    npx vercel --prod

Or drag the folder into vercel.com/new. Then add two variables under
Settings → Environment Variables and redeploy:

    METABASE_HOST      https://arena-club.metabaseapp.com
    METABASE_API_KEY   <an API key with read access>

That is enough for the DOI dashboard, Duplicates, Warehouse, and WIP sports.
The Order List feed needs no credentials at all. Only inbound sports need the
Google service account described below.

Check it worked:

    /api/doi                 twelve categories of pack bands
    /api/warehouse?limit=1   total card count
    /api/sheets?feed=pos     open POs

## Two modes

**Public mode — no setup.** Deploy as-is and `/api/sheets?feed=pos` reads the
Operations Order List over its shared link. Live inbound and WIP, no
credentials, nothing to configure. Sport counts are unavailable in this mode:
the buying sheets are private, and Google hides column H's link chips from the
public CSV export, so there is no way to reach them.

**Service account mode — sports as well.** Set the variables below and the same
endpoint switches over automatically: it reads the link chips, opens each
buying sheet, and pulls just the Sport columns.

## Deploy

1. `vercel` (or import the folder in the Vercel dashboard)
2. For sports, add Settings → Environment Variables:

   | name                  | value                                           |
   |-----------------------|-------------------------------------------------|
   | `GOOGLE_CLIENT_EMAIL` | service account address, ends `.iam.gserviceaccount.com` |
   | `GOOGLE_PRIVATE_KEY`  | its private key — paste including the BEGIN/END lines |
   | `ORDER_LIST_ID`       | `1bg9BZufjr5cXDlKLuRkzOD0KgZbwqzWE0U8Sfwz502U`   |

3. Redeploy.

## The service account

Google Cloud console → IAM & Admin → Service Accounts → create one → Keys →
Add key → JSON. Enable the **Google Sheets API** for that project.

Then share with the service account's email address, Viewer is enough:

- the Operations Order List
- the Drive folder holding the PO buying sheets (covers all of them at once)

This is why the browser couldn't read them: those sheets are private, and a
service account is a real identity you can grant access to, rather than making
them public.

## Endpoints

    /api/doi                                DOI pack bands per category (Metabase)
    /api/duplicates                         duplicate cards, question 36730 (Metabase)
    /api/warehouse                          warehouse cards, question 4131 (Metabase)
    /api/wip                                WIP detail, question 36763 (Metabase)
    /api/wip?raw=1                          its column names, to confirm the mapping
    /api/sports                             sport split per PO (Metabase)

    /api/sheets?feed=pos                    open POs, inbound + WIP
    /api/sheets?feed=sports&po=4222         sport counts for one PO
    /api/sheets?feed=sports&all=1&limit=20  sport counts across open POs

`feed=pos` reads Dashboard!A3:Y and Order List!A2:O, and pulls the column H
link chips through `spreadsheets.get` — the same field Apps Script's
`fetchHyperlinksV4_` uses, which plain CSV export cannot see.

`feed=sports` opens a buying sheet, finds every column headed *Sport* or
*Character* in the first four rows, and reads only those columns. That keeps
each PO to a few hundred cells instead of the whole sheet — the size problem
that broke every other approach. Results cache 10 minutes per warm instance.

## Metabase

Two of the three feeds come from Metabase and need only:

    METABASE_HOST      https://arena-club.metabaseapp.com
    METABASE_API_KEY   an API key with read access

`/api/doi` runs one saved question per category. Twelve are built in:

    Baseball 16865 · Basketball 16867 · Football 16864 · Pokemon 16866
    One Piece 16870 · Hockey 16871 · Soccer 16869 · Yu-Gi-Oh 16868
    Disney 16872 · UFC 16876 · Star Wars 16878 · Hero 16879 (DC / Marvel)

Add more without touching code:

    DOI_QUESTIONS="Marvel:16873,Wrestling:16874"

Columns are matched by name, so PACK / LOWER_BAND / CURRENT_INVENTORY /
CARDS_KEPT / DOI / DAILY_OUTPUT can appear in any order.

`/api/duplicates` runs question 36730 once, caches it 15 minutes, and filters
server-side on sport, set, player, parallel, tag, grading company, grade and a
min/max estimated value. Dropdown options come from the data itself, so new
sports or graders appear without a change here. Override the id with
`DUPLICATES_QUESTION`.

`/api/warehouse` runs question 4131 the same way, filtered on sport, tag, cert
number, AC number, PO number, set, player, parallel, grading company, grade and
an estimated-value range. Slab thumbnails come straight from the question's
picture URL column. Override the id with `WAREHOUSE_QUESTION`.

Both the Duplicates and Warehouse tabs have an **Open in Metabase** button that
carries the current filters into the saved question as URL parameters. The
widget slugs are in `MB_SLUGS` in index.html — if a filter on the question is
named differently, change it there.

`/api/sports` parses the PO number and sport code out of
`admin.orders.purchase_location` ("po 4150 1-99 pkmn p3"). That covers received
POs only — inbound cards have no order yet, so their sports come from the
buying sheets via the service account.

## Stage rules

- Dashboard column T complete → dropped
- column H received false → **Inbound**
- received true, not yet processed → **WIP**
- processed (Order List column M, or Dashboard verified) → leaves WIP

## Front end

`index.html` loads `/api/sheets?feed=pos` on open and falls back to the
bundled snapshot if the API is unreachable, so it still renders locally.

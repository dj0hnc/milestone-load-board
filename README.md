# Milestone Load Board — Desktop (v2.0, NewMile-connected, portable)

A single-file Windows app that **connects to NewMile by itself** — no Claude in the middle.
It signs in to NewMile through an **in-app browser window** (OAuth 2.1), stays connected
(token + auto-refresh), shows a connection light, pulls the day's orders + truck roster +
rotation **live**, and **pushes** a planned batch back to NewMile with a per-order
confirmation, following Milestone's standing dispatch rules.

The cockpit is the same Load Board you already use (planner on top, drag-to-assign,
fleet/terminal grouping, rotation flags), embedded inside the app.

---

## Run it (no install)

Double-click **`dist/MilestoneLoadBoard-2.0.0-portable.exe`**. That's it — it's a portable
single file, copy it to a USB / another PC / a shared drive and it just runs. No Node, no
install, no admin.

1. **Connect to NewMile** → an in-app sign-in window opens (NewMile login). Approve → the
   light turns green and shows your name + org.
2. Pick a **Day** → **↻ Refresh** → yesterday / today / tomorrow load live, with the
   rotation (ran-yesterday) flags from the last working day's load tickets.
3. Plan in the board (click orders, drag trucks, type loads).
4. **⬆ Push plan…** → review the per-order preview (rule badges shown) → **Push** each order
   or **Confirm & push all**. Assignments are created **and confirmed** in NewMile.
5. **⚙** opens the connection log (diagnostics) if anything needs troubleshooting.

### Smart Dispatch panel (bottom-right)
A built-in assistant docked in the board:
- **⚡ Auto-plan** (or Alt+A) — fills uncovered orders with **rested** trucks (didn't run
  yesterday, per NewMile rotation), respecting min-truck counts and loads-to-cover. You review
  and adjust before exporting/pushing. Skips orders that already carry NewMile trucks.
- **Live rule checks** — flags ATX Bluewing, missing load limits, trucks with no driver
  (missing_driver risk), the same truck on multiple orders, unknown numbers, and EYK/Watercrest
  (order_default) — **before** you push.
- **Repeated truck numbers** — when a number belongs to more than one truck (1387 is both an
  Alanis truck and a Cactus truck), the board asks **which one** before the chip lands, the same
  way the mobile app asks on push. It remembers the answer for the session, shows the owner on the
  planner chip (tap it to change), and sends that truck's **NewMile id** on the push, so the
  assignment can never drift to the other owner. Trucks dragged from the rail or chosen by
  Auto-plan never ask — they already carry their id.
- **KPIs / forecast** — projected fulfillment %, trucks/tons planned, orders still short, and
  how many rested trucks are still idle.

The connection is **verified** against the live NewMile server (app.newmile.com):
dynamic client registration + PKCE login work, scopes `mcp:read mcp:write claudeai`.

---

## What this version fixed (vs the earlier draft)

The earlier build was written to the OAuth/MCP spec but never tested against live NewMile.
Verified on 2026-06-10, these were corrected so the **first real push won't fail**:

- **`finalize_load_plan` does not exist.** The flow is `bulk_create_assignments` →
  `confirm_assignments`. Confirm **is** the finalize (draft → pending; triggers the
  auto-offer flow). Never `send_offer`, never `close_order`.
- **`bulk_create_assignments` is a utility** (`call_utility`) and needs `truck_id`, not a
  truck number — the app resolves each number to its NewMile id first.
- **`confirm_assignments` takes the array of created assignment IDs**, not an order id.
- **`ordinal` is not settable on create** — list order sets it; blue / seq-2 trucks are
  placed with `reorder_assignments` after creation (best-effort).
- **Rate block:** `rate_source: contracted_rate`, `driver_pay_rate_source: custom`,
  `driver_pay_rate: 0`, `driver_pay_rate_measurement_unit_id: 1` (Ton). EYK / Watercrest
  orders → `rate_source: order_default` (auto-detected). ATX Bluewing excluded everywhere.

## Push safety (unchanged rules)

- Per-order, **confirm-before-write**. Idempotent: trucks already on an order are skipped.
- Reads are free; writes are previewed with rule badges and only run on your click.

## Files

```
dist/MilestoneLoadBoard-2.0.0-portable.exe   the app (double-click)
main.js              app window + IPC; in-app OAuth window; day-pull + push
mcp-client.js        NewMile MCP client: OAuth (DCR/PKCE/client_secret_post) + JSON-RPC + verified push
preload.js           safe bridge (window.newmile.*)
renderer/shell.html  connection bar, diagnostics drawer, push preview modal
renderer/shell.js    maps live NewMile data into the board, runs the confirmed push
renderer/board.html  the embedded load board (__applyLiveData + __getPlan hooks)
newmile.config.json  connection + OAuth (endpoints verified, discovery on)
```

See **BUILD.md** to rebuild the .exe from source.

## Cloud reports (report-engine/)

GitHub Actions sends the reports by itself — no PC needed (see `.github/workflows/report.yml`):

- **morning** (7:30am CT) — no-show report.
- **night** (8pm CT) — fleet assignment for tomorrow.
- **sf** (Mondays) — **Service Failures + GP dollars of lost loads** for last week Mon-Sat.
  GP comes from the LOGGED FAILURES (loads counted in the failure notes; Financial/No Show
  failures with no count = 1; order-level vs truck-level counts deduped), priced at each
  order's actual avg load size × the PO+material's realized per-unit margin that week
  (`service_failures` + `orders` + `po_margin` reports). Reported as a range: GP Lost
  (direct floor) and GP At Risk (every failure ≥1 displaced load). The email attaches the
  full Design-style PDF (rendered with the runner's Chrome via puppeteer-core; skipped
  gracefully if unavailable) plus two CSVs (per-order GP + the raw failure log with
  per-row load counts). Recipients: secret `REPORT_TO_SF` if set (its own list, e.g.
  leadership), else the shared `REPORT_TO`. Rerun any week manually:
  Actions → MAB Reports → kind `sf` (uses last week), or locally
  `node report-engine/report-cli.js sf --local --from=2026-08-03 --to=2026-08-08`.

The same report lives **inside the app**: the **📉 SF Report** button (top bar, enabled when
connected) opens a viewer for ANY Mon-Sat week — build on demand, **✉ Send** (email with the
full Design-style PDF + both CSVs attached; Resend key in the window's ⚙ or the config
`report` block), **🖨 PDF** (the same document the team used to hand-build: executive summary,
GP of lost loads, failures by day, why/party/customer, no-shows, full failure detail), and
**💾 Save CSVs**.

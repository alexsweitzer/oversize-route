# OverSize Route — Project Context for Claude Code

## What this is
A permit-compliant GPS dispatch platform for Kentmorr Marine Transport (KMT), an
oversized-load trucking company in Stevensville, MD. Dispatchers upload state DOT
oversize permits (PDFs), AI extracts the exact legally-required route road-by-road,
and the app sends turn-by-turn navigation to the driver's phone. The legal requirement:
the driver MUST follow the roads on each state's permit exactly.

Test route used throughout development:
**910 Kentmorr Road, Stevensville, MD → 800 S Washington Ave, Ludington, MI**
(5 permits: MD, WV, PA, OH, MI — real permit PDFs, cleanly machine-readable)

## Infrastructure (all live)
- **This repo** auto-deploys to **Railway** on every push to `main` (paid plan, upgraded)
- **Live URL:** https://web-production-00975.up.railway.app
- **Login:** admin@oversizeroute.app / ChangeMe123! (may have been changed)
- **Database:** Railway PostgreSQL (NOT Supabase — that's a different KMT project)
- **Env vars in Railway (web service → Variables):**
  - `ANTHROPIC_API_KEY` — powers permit extraction (claude-sonnet-4-5)
  - `MAPBOX_TOKEN` — map display tiles + drawing
  - `HERE_API_KEY` — HERE REST API key: geocoding + truck routing
  - `GOOGLE_MAPS_API_KEY` — legacy, mostly unused now
  - `DATABASE_URL`, `JWT_SECRET`, `APP_URL`, `NODE_ENV` — standard

## File structure
```
src/
  server.js          Express app; /api/config passes public keys to frontend
  db/                pool.js, migrate.js, seed.js
  middleware/        auth.js (JWT), upload.js (multer → /uploads)
  routes/            auth.js, routes.js, permits.js, drivers.js, driverView.js
  services/ai.js     Anthropic permit extraction (THE core logic)
public/
  index.html         Office portal (single file: all CSS/JS inline)
  driver.html        Mobile GPS driver app (voice, live GPS, wake lock)
```
DB tables: users, drivers, routes, permits, location_pings, activity_log.
Note: routes.status has a CHECK constraint allowing only ('draft','ready','sent',...) —
'analyzing'/'error' are NOT allowed; async state is tracked in ai_analysis JSON
(`_analyzing: true` / `_error: msg`) instead.

## What is WORKING (verified)
1. **AI permit extraction is excellent.** `src/services/ai.js` reads full PDF text
   (pdf-parse, NO truncation — OH/MI permits are 10K+ chars), sends all permits to
   claude-sonnet-4-5 (max_tokens 8000, timeout 280s), returns ~76 structured legs:
   `{seq, state, road, direction, to, lat, lng, raw}` in travel order MD→WV→PA→OH→MI,
   plus permit_start, permit_end, alerts (Bay Bridge notify, WV escort/night bans, etc.)
2. **Auto-connector logic:** true origin → permit start road (MD-8), and permit end
   (US-10 in MI) → true destination, per the owner's requirement.
3. **Async analysis pattern (critical):** Railway's gateway kills any request at 60s.
   `/analyze` responds immediately and runs analysis in background;
   frontend polls `GET /api/routes/:id/analyze-status` every 3s (no-cache headers are
   REQUIRED on that endpoint — browser 304 caching broke polling once already).
4. **Turn-by-turn display** is permit-exact and legally correct.
5. **HERE flexible polyline decoder** in index.html is verified correct against a
   spec-compliant test vector (the decoding table was wrong once — fixed and tested).
6. **Login, permits upload, drivers, share links, driver GPS app** all work.

## The CURRENT problem (where work stopped)
The map line accuracy. The pipeline is: AI legs → per-leg coordinates → HERE truck/car
routing through those points (chunked, 14 per request) → decode polyline → draw amber
line on Mapbox. The line now roughly follows the corridor (I-68/I-79 Morgantown ✓,
I-70 Washington PA ✓, I-77 Canton ✓) but still has local wandering (e.g., a wrong dip
toward Fort Wayne IN; some Michigan zigzag — though note the MI permit LEGITIMATELY
zigzags through mid-Michigan back roads).

**Latest change (deployed but NOT yet verified by a test run):**
- ai.js now asks the AI to emit approximate `lat`/`lng` for each leg's ending junction
  (Claude's own geographic knowledge of highway junctions), used as PRIMARY map
  via-points — HERE snaps them to roads. Geocoding (proximity-chained HERE geocode,
  `at=` bias from previous point, state-bbox validated, score-filtered) is now only a
  FALLBACK for legs missing coords.
- A/B markers now pin to the drawn line's literal first/last coordinates.
- `filterOutliers()` does monotonic corridor projection (unit-tested logic): rejects
  points >35% of trip length off-axis or backtracking >6%.
- **User must click "Analyze Permits & Build Route" fresh** (not redraw) so legs
  regenerate WITH coordinates. Console logs: `Leg points: X from AI coords, Y geocoded`.

## Next steps (in order)
1. Run a fresh analysis on the MD→MI test route; check console for
   `Leg points: X from AI coords...` and assess line accuracy.
2. If AI coords are good but line still locally off: consider snapping AI coords via
   HERE's route-matching, or increase via-point density on problem legs.
3. Consider `transportMode=truck` again in hereRouteThrough (currently `car` because
   truck mode rejected routes without vehicle dims — add height/weight params from
   the permit dims: 75'L x 11'6"W x 13'6"H, 40-49K lbs).
4. Fix cosmetic `Permit UNKNOWN` state detection (guessStateFromFilename in
   routes/permits.js) — AI figures out states anyway.
5. Add `app.set('trust proxy', 1)` in server.js (rate-limit warning in logs).
6. Driver app (driver.html) still draws its own canvas map — eventually feed it the
   same HERE geometry.

## Hard-won gotchas (do not re-learn these)
- Railway gateway timeout is 60s and NON-NEGOTIABLE → keep analysis async.
- HERE `/geocode` endpoint REJECTS `in=bbox:` (400) — use `in=countryCode:USA` +
  validate results against state bounds client-side. `at=lat,lng` proximity bias works.
- HERE routing coords are `lat,lng` order (opposite of Mapbox/GeoJSON `lng,lat`).
- HERE Directions: chunk via-points (~14/request); decode flexible polyline with the
  CORRECTED decoding table already in index.html.
- Mapbox marker custom elements: rotated-pin CSS transforms fight Mapbox positioning
  and drift on zoom — use center-anchored simple dots.
- Geocoding highway interchanges from text ("I-70 Exit 208") is fundamentally
  unreliable on both Mapbox AND HERE — that's why AI-emitted junction coords are the
  primary strategy now.
- max_tokens 3000 truncated the AI JSON once (caused silent TX/LA demo fallback,
  since removed). Keep 8000+ for extraction.

## Working style with the owner (Alex/Brady)
Non-developer but technical; previously uploaded files via GitHub web UI. Prefers
concrete step-by-step instructions, screenshots for verification, and honest
assessments over hedging. Precision of the permit route is a LEGAL requirement —
"close enough" is not acceptable for the final product.

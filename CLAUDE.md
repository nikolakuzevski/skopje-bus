# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A personal replacement for JSP's official Skopje bus app, built because that
app is wrong in three specific ways: its ETA countdown jumps around and reaches
zero at empty stops, buses arrive that it never listed, and it takes too long to
answer one question. Everything in here exists to fix one of those three things.

Plain HTML/CSS/JS: no framework, no build step, no bundler, no package.json.
Hosted as a static site and installed on the phone via "Add to Home screen".
UI language is Macedonian, because every stop name and headsign the API returns
is already Macedonian Cyrillic.

This is its own git repository, separate from the sibling projects in the parent
folder (see `../CLAUDE.md`) — they share no code. It follows the same shape as
`../daily-planner/`: IIFE modules extending one global (`SB`), script order in
`index.html` as the dependency graph, and an `sw.js` whose `ASSETS` list must
mirror that script list.

## Commands

There is no build, lint, or test tooling.

- **Run locally**: `powershell -ExecutionPolicy Bypass -File dev-server.ps1`
  then <http://localhost:8000/>. Never open `index.html` over `file://` —
  the service worker and geolocation both need a real HTTP origin. The parent
  folder's other `dev-server.ps1` files all bind port 8000, so only one project
  can run at a time.
- **Deploy**: push to `main`; GitHub Pages serves the repo root. No build runs.
- **No automated tests exist.** See Verification below.

## The data source

Everything comes from **Modeshift**, the third-party platform JSP's own site and
app run on. `js/api.js` is the only file that knows this. It is public,
unauthenticated, and sends `Access-Control-Allow-Origin: *` — verified by
calling it from an unrelated origin — which is the entire reason this app can be
a static page with no backend, no key and no proxy.

Base: `https://www.modeshift.app/api/v1/<tenant>/` where the tenant UUID is
JSP's, read from `skopjebus.mk/wp-content/plugins/planner/data/settings.json`.

| Path | Content | Measured |
|---|---|---|
| `transport/planner/vehicles` | live buses; also accepts `?stopId=N` | ~100 buses, 36 KB, fixes 15-35s old |
| `transport/planner/vehicles/route/N` | same for one route | |
| `transport/planner/routes` | routes with ordered per-pattern stop lists | 92 KB, cached a day |
| `transport/planner/stops` | ~1431 stops with coordinates | cached a day |
| `transport/gtfsrt/tripupdates` | GTFS-RT trips | **12 MB, ~1.2s**, no server-side filter |
| `transport/gtfsrt/alerts?mediaType=WebPortal` | service alerts | tiny, unused so far |

**This API is undocumented and can change or close without notice.** That is the
main standing risk. Every URL and every upstream field name is normalised inside
`js/api.js` so a break is a one-file fix; nothing else in the codebase ever sees
a raw upstream field.

Two upstream quirks worth knowing before trusting a field:

- The plain `/vehicles` list calls the bus's next stop `stopId`, while
  `/vehicles/route/N` calls the identical thing `currentStopId`. `api.js`
  collapses both to `nextStopId`.
- In `tripupdates`, `arrival.time` is always `0` and `delay` is measured against
  a static schedule this app cannot see (there is no public GTFS for Skopje).
  On trips with no live vehicle that `delay` comes back as several hours, which
  is why `js/untracked.js` deliberately does not read it. What TripUpdates is
  reliably good for is *which trips exist right now and which vehicle is on
  each* — nothing more.

## Architecture

```
js/dom.js        el() helper, in-app confirm, haversine, Macedonian formatting
js/api.js        the ONLY file that knows Modeshift; normalises at the boundary
js/cache.js      IndexedDB kv + the routes/stops snapshot and its lookup indexes
js/store.js      the ONLY file that touches localStorage (preferences only)
js/history.js    learned stop-to-stop travel times
js/eta.js        the prediction engine
js/debug.js      predicted-vs-actual accuracy measurement
js/untracked.js  the expensive TripUpdates check for buses with no GPS
js/ui-*.js       the three tabs
js/app.js        boot, poll loop, tabs, the one-second clock
```

### Why the app feels fast

`SB.net.ensure()` is cache-first: routes and stops come out of IndexedDB and a
full screen is drawn **before any network call is made**. The live poll only
fills in numbers on a page that already exists. Geolocation runs in parallel and
can never block rendering — and it can only override an empty screen, never a
stop the user pinned.

### Two update rates, on purpose

`js/app.js` polls `/vehicles` every 15s. `js/ui-stop.js` rebuilds the list only
when the *set* of approaching buses changes, and repaints only the time text
once a second. Countdowns therefore tick smoothly instead of lurching once per
poll, and nothing on screen moves unless something really changed.

The poll loop stops entirely while `document.hidden`, and backs off
exponentially to a two-minute ceiling on repeated failure. **Note when testing:
a hidden browser tab will not poll — that is correct behaviour, not a bug**, and
it is the most likely reason a headless check sees no data.

### The ETA engine (`js/eta.js`)

For bus `V` and stop `S` on `V`'s pattern: `i` = position of `V`'s next stop,
`j` = position of `S`.

- `j < i` — already passed, dropped.
- `j === i` — arrival is `V.nextStopArrival` verbatim. This is upstream's own
  estimate for its immediate next stop and is the most reliable number in the
  whole feed. Do not try to improve on it.
- `j > i` — that anchor plus each intervening segment, from `js/history.js`
  where observed and from stop-to-stop distance where not.

Three behaviours exist specifically to fix JSP's app and should not be
"simplified" away:

1. **A predicted arrival instant is held per (vehicle, stop)**, not a countdown.
   Each poll nudges it by an EMA; a move larger than 45s snaps through
   immediately. Measured: with the raw estimate jittering across a 38-second
   span, the displayed value stayed inside an 8-second band, while a genuine
   4-minute correction still came straight through.
2. **A GPS fix older than 90s stops the countdown** and shows "нема сигнал" with
   the age. A countdown running on dead data is exactly how you get "0 min" at
   an empty stop.
3. **Predictions more than 5 stops out are shown as a range**, because they are
   one. False precision is the failure being replaced.

A stop that appears twice on a loop pattern keeps its **first** position
(`cache.js`), so a bus is never told it has already passed a stop it is still
approaching.

### Learned travel times (`js/history.js`)

When a bus's next stop advances by exactly one position between polls, the
elapsed time is that segment's real traversal time. Samples are bucketed by
`(pattern, fromPosition, hourOfDay)`, kept as a rolling window of 12, and read
back as a median with fallback to adjacent hours then any hour.

Only intervals whose *start* was witnessed are recorded (the `confirmed` flag) —
otherwise the first sighting of a bus produces a garbage sample. This only
records while the app is open, so the model builds slowly and is biased toward
the hours the user actually travels. That is the right bias, but it means early
predictions are distance-based.

### Measuring whether this is actually better (`js/debug.js`)

Every prediction is logged with the moment it was made; when the bus later
passes that stop, each earlier prediction gets an error, bucketed by how far
ahead it was looking. The Information tab shows mean absolute error and bias.
**This is the only evidence that the app beats the one it replaces** — if a
change to `eta.js` does not improve these numbers, it did not help.

### Buses with no GPS (`js/untracked.js`)

Measured 2026-09-07 20:49: of ~188 trips that should have been running, 32 had a
vehicle assigned in TripUpdates but no entry in the vehicles feed. Those are the
buses that turn up having never appeared in the app.

Closing that gap costs a 12 MB unfilterable download, so it is an explicit
user action from the Information tab, cached 3 minutes, and skipped when
`navigator.connection.saveData` is set. Trips are filtered to those plausibly
running now, using stop count times 2 minutes as a trip-length estimate —
without that filter, finished trips inflate the count (25 became an honest 17).
If this ever proves too heavy on real mobile data, the fallback is a small
server-side proxy doing the filtering remotely; that would break the
"no backend" property, so treat it as a last resort.

## Verification

There is no fixture for a live third-party feed, so verification is empirical.

- **Accuracy is the only measure that matters.** Ride real routes, then read the
  Information tab's error figures. Everything else is decoration.
- **The service worker will serve stale JS during development.** Bump
  `CACHE_VERSION` in `sw.js` on every change to a cached file, or unregister the
  worker and clear caches before reloading. This is the most likely cause of an
  "impossible" result while iterating.
- A hidden tab does not poll (see above).
- Offline: the shell must load from cache and show an explicit stale state, never
  a blank screen. Live data is deliberately never cached — a ten-minute-old bus
  position is worse than none.

## Design rules

No purple gradients, no pill-shaped buttons, no emoji as icons, no em dashes in
UI copy, no heavy scroll animation. One accent colour, used only for the live
signal. These are standing constraints, not preferences.

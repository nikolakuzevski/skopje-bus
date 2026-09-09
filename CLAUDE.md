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
js/eta.js        the prediction engine for buses with live GPS
js/timetable.js  the daily timetable: hour-ahead rows and buses with no GPS
js/debug.js      predicted-vs-actual accuracy measurement
js/ui-*.js       the four tabs (stop, map, pick, info)
js/app.js        boot, poll loop, tabs, the one-second clock
vendor/leaflet/  Leaflet 1.9.4 (MIT), vendored deliberately - see The map below
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
4. **A dead feed freezes the whole list.** On a failed poll `app.js` only sets a
   banner; `onData` never runs, so every row keeps its last arrival instant and
   the one-second tick would happily count it down to `сега` for a bus nobody
   has heard from. `ui-stop.js` reads `SB.app.feedAgeMs()` and, past
   `FEED_STALE_MS`, replaces every live row's countdown with `нема податоци`.
   Note this is distinct from a single vehicle's stale GPS: the feed being down
   invalidates every row at once.

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

`confirmed` alone is **not** sufficient, and relying on it was a bug: it only
means "same pattern as last poll", so any break in the poll loop (backgrounding,
offline, backoff) produced a sample spanning the entire gap and permanently
poisoned that segment's median. `continuousSince` tracks the start of the
current unbroken run of observations, and an interval that began before a gap
longer than `MAX_POLL_GAP_MS` is discarded. Having no sample beats having a
wrong one, because a poisoned median never heals.

### Measuring whether this is actually better (`js/debug.js`)

Every prediction is logged with the moment it was made; when the bus later
passes that stop, each earlier prediction gets an error, bucketed by how far
ahead it was looking. The Information tab shows mean absolute error and bias.
**This is the only evidence that the app beats the one it replaces** — if a
change to `eta.js` does not improve these numbers, it did not help.

### The daily timetable (`js/timetable.js`)

Absorbs the old `untracked.js` — both that feature and the hour-ahead list need
the same 12 MB feed, so it is fetched once, reduced, and reused. It is an
explicit tap in the Information tab, never automatic, and is skipped when
`navigator.connection.saveData` is set.

**Reduction**: 3032 today-trips reduce to a ~73 KB compact table of
`{tripId, routeId, patternIndex, startMin}`. 3023 of them (99.7%) match a known
route pattern exactly on routeId plus ordered stop list, so they reuse the
learned segment times; the 9 that do not carry their own stop list inline.
The 12 MB object is dropped immediately after reduction.

**THE CRITICAL LIMIT, measured twice: TripUpdates is a live operational feed,
not a published timetable.** At 18:26, 5 of 1472 today-trips had a future start
time. At 21:23, 3 of 3013. It lists trips already dispatched, not the coming
hour's schedule. There is also no timetable endpoint anywhere: 12 candidate
paths all 404, and JSP's own web bundle references only five transit endpoints
(`planner/routes`, `planner/stops`, `planner/plan`, `gtfsrt/alerts`,
`planner/vehicles`). **A full forward timetable cannot be built from this API.
Do not add one without a new, verified data source.** What the hour-ahead list
actually does is extend the stop view past `eta.js`'s `MAX_STOPS_AWAY` cap and
add trips with no GPS, which is a real gain but is not the same thing.

**Because it is a rolling feed, a once-per-day snapshot is wrong**, and building
one was a mistake worth not repeating. A snapshot cannot contain trips
dispatched after it was taken, so `SNAPSHOT_TTL_MS` is 30 minutes and
`isFresh()`, not `isLoaded()`, gates whether rows are drawn. Two related traps:

- **An empty snapshot must never be cached as authoritative.** Just after
  midnight the feed legitimately returns zero trips (verified at 01:26: 0
  entities, 0 vehicles, first departure 01:30). Caching that under today's date
  made `ensure()` accept it for the rest of the day, so the whole feature would
  have silently shown nothing until tomorrow. `fromCache` rejects empty.
- **This module now supplies only what the live feed cannot know**: buses
  running with no GPS, and trips that have not departed. Anything with a live
  position belongs to eta.js.

**Far buses come from the live feed, not from here.** `eta.js`'s
`arrivalsForStop` takes an optional `maxStopsAway`; `ui-stop.js` calls it once
at `FAR_MAX_STOPS` (40) and splits the result at `NEAR_MAX_STOPS` (12) into
confident rows and wide-range `is-far` rows. That is the bulk of the hour-ahead
view and it costs nothing extra — the same 36 KB poll either way — so it works
with no download at all. Only the two cases above need the 12 MB.

**Row states** from this module:

- `no_signal` — started, no live vehicle at all. Labelled `предвидување`.
- `predicted` — not yet departed. Labelled `предвидување`.

`rendered` and `live` are **different sets** and conflating them was a shipped
bug: eta.js stops at its range cap, so a tracked bus can be absent from the
list, and treating "absent" as "untracked" made 7 of 8 rows falsely claim
`нема сигнал од возилото`. Dedupe against what eta.js *rendered*; decide
tracked-ness from the *live vehicle list*. `upcomingForStop` takes both.

**Uncertainty is measured, not invented.** A schedule-only prediction was
compared against the live feed's own estimate for 100 buses. Median absolute
error 3.7 min, p90 17.5 min, and error grows steeply with distance from the
trip origin:

| stops from origin | median | p90 |
|---|---|---|
| 1-3 | 1.6 min | 5.5 min |
| 7-10 | 3.4 min | 7.1 min |
| 16-25 | 7.6 min | 16.3 min |
| 26-40 | 12.9 min | 36.5 min |
| 41+ | 21.9 min | 54.4 min |

`ERROR_CURVE` encodes that, and past `NO_ESTIMATE_AFTER_MIN` (35 minutes into a
trip, where p90 exceeds half an hour) **no minute figure is printed at all** —
only the departure time, which is the one thing upstream actually states. A row
whose central estimate is already in the past shows `до N мин`, never a clamped
`1-N мин`, which would claim the bus is still at least a minute away.

### The map (`js/ui-map.js`)

A **subscriber, never a fetcher**: `app.js` hands it each poll's vehicles. It
owns no timers and makes no API calls; giving it its own poll would double load
on an undocumented API for no new information.

Leaflet is **vendored** in `vendor/leaflet/`, not loaded from a CDN, because
`sw.js` deliberately ignores cross-origin GETs — a CDN copy could never be
precached and the map would be dead offline. It is injected lazily on first
`mount()` so a user who never opens the tab pays nothing at boot.

Three details that will be got wrong if changed carelessly:

- **Rotation must live on an inner span.** Leaflet rewrites `transform` on the
  marker's root element on every `setLatLng`, pan and zoom, so a heading applied
  to the root is silently erased each poll. `.bus-pin` is the root Leaflet owns;
  `.bus-arrow` is ours.
- **`#panel-map[hidden]` needs `display:none !important`.** `app.js` toggles
  `panel.hidden`, and the UA stylesheet's `[hidden]{display:none}` loses to an
  author `display:flex`. Without it the map renders on every tab.
- **A ResizeObserver on the container is required**, not a one-shot
  `invalidateSize()`. Leaflet caches its pixel size at init and loads tiles only
  for that rectangle; a map created while its panel is hidden, or a device
  rotation afterwards, leaves it loading a single tile into an empty view. This
  was observed, not theorised.

Honesty rules specific to this view: markers tween 1.2s between two genuinely
reported positions and then stop — dead-reckoning along `heading` and `speed`
would be drawing a position nobody reported. A vehicle with null heading (or
near-zero speed) gets a plain dot, because a north-pointing arrow on a bus of
unknown heading is an invented fact. Buses with no GPS cannot be drawn at all;
the header states how many are missing only when a fresh timetable download
makes that count knowable (`SB.timetable.runningWithoutGps`) — the `/vehicles`
feed alone can never answer it, since it by construction contains only buses
that ARE reporting a position, so comparing its length to the drawn count
always reads close to zero and is not the same fact.

## Second audit pass (2026-09-09)

A follow-up audit, adversarially verified per finding, found and fixed several
more bugs. Recorded here because each one encodes a lesson worth not relearning:

- **NaN could enter and never leave.** `js/eta.js`'s `smooth()` used an EMA that
  silently absorbs a NaN input and then can never recover from it (every future
  comparison against a stored NaN is also false, so it never re-snaps to a good
  value). The real entry points are now closed at the source instead: `js/api.js`
  normalises `lat`/`lon` to `number | null` like `heading`/`speed` already were,
  and `js/eta.js`'s distance fallback only computes a real haversine when every
  coordinate involved is an actual number, falling back to the honest flat
  default (300m) otherwise — never letting `null` silently coerce to `0` and
  measure from the equator. `smooth()` itself still has a defensive
  `Number.isFinite` guard as a last resort, and `js/history.js`'s `record()`
  gate now uses `Number.isFinite` too, since `NaN < X` and `NaN > X` are both
  false and used to slip a poisoned sample past the sanity check.
- **A live status could be stale and still read as "right now."** A missing
  `lastUpdated` was treated as fresh, not unknown, in three places (`eta.js`,
  `ui-map.js`) — inverted from the intended defence. `at_stop`/`arriving` also
  had no age qualifier at all despite being live-status fields that can
  themselves be up to `STALE_MS` old, so "на постојка" could read as certain
  when it was 89 seconds old.
- **"сега" and a clamped range could overstate a low-confidence guess.** The
  `сега`/`due` cutoff ran before the confidence check, and the EMA smoothing can
  fall behind the wall clock for a low-confidence row (each poll closes only
  25% of the gap), letting `predictedAt - now` cross the threshold while the raw
  estimate was still minutes out. Confidence is now computed first and gates
  both. Separately, `eta.js`'s low-confidence range clamped its low end up to 1
  minute; it now uses the same `до N мин` form `timetable.js` already used for
  the identical situation, rather than claiming a floor the estimate doesn't
  support.
- **"тргнал HH:MM" asserted a departure nobody observed.** Every row
  `timetable.js` emits belongs to a trip with no live vehicle, and `arrival.time`
  is 0 in every upstream entry (see above) — there is no confirmation it left.
  Both `label()` and `detail()` now say `по ред HH:MM` (scheduled), not `тргнал`.
- **A snapshot could outlive its service day unnoticed.** `runningWithoutGps()`
  had no day check, so leaving the app open overnight let yesterday's trips be
  filtered against today's clock and inflate the Information tab's "no GPS"
  count. It now returns `[]` outright once `dayStamp !== stampOf(now)`.
- **DST changeover shifts every scheduled prediction by an hour.** `nowMin` was
  elapsed real time since a computed midnight instant, while `startMin` (parsed
  from `"HH:MM:SS"`) is wall-clock — those diverge by exactly the DST offset on
  the two days a year it changes. Both are now read from the wall clock
  directly (`wallClockMinutes`/`wallClockInstant` in `timetable.js`), which
  resolves the local offset for the instant in question and cancels the shift.
- **Reliability, not honesty, but worth recording:** a boot failure used to
  permanently kill the poll loop with no retry (`app.js` `bootNetwork()` now
  retries with backoff); a `visibilitychange` resume used to poll immediately,
  bypassing the deliberate exponential backoff every app-switch or screen
  unlock (now routes through `pollRespectingBackoff()`); `poll()` had no
  in-flight guard, so an out-of-order response could poison a learned segment
  sample (now guarded); and rapidly tapping away from and back to the map tab
  while Leaflet was still loading could create two `L.map()` instances on the
  same container and permanently wedge the tab (`ui-map.js` now guards with a
  `mounting` flag).
- **Not fixed, logged as a known limitation:** `js/cache.js`'s `orderByKey`
  keeps only a stop's first position within a pattern (needed so a bus is never
  told it already passed a stop it is still approaching). Measured against the
  live `/planner/routes` feed on 2026-09-08: of 204 patterns, exactly one
  (route 63А pattern 11) repeats a stop consecutively, and that duplicate makes
  two of that one pattern's segments permanently unlearnable — they fall back to
  distance forever rather than ever getting a learned time. Narrow (one pattern)
  and degrades honestly (worse estimate, not a wrong one), so left as recorded
  debt rather than fixed under time pressure.

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

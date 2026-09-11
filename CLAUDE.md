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
js/dom.js        el() helper, icon() svg builder, in-app confirm, haversine, Macedonian formatting
js/api.js        the ONLY file that knows Modeshift; normalises at the boundary
js/cache.js      IndexedDB kv + the routes/stops snapshot and its lookup indexes
js/store.js      the ONLY file that touches localStorage (preferences only)
js/history.js    learned stop-to-stop travel times
js/eta.js        the prediction engine for buses with live GPS
js/timetable.js  the daily timetable: hour-ahead rows and buses with no GPS
js/debug.js      predicted-vs-actual accuracy measurement
js/ui-stop.js    the main screen: one stop, every bus coming to it
js/ui-detail.js  full-screen view of ONE tapped bus, with its own small map
js/ui-pick.js    stop search
js/ui-info.js    settings + accuracy figures, opened from the header gear icon
js/app.js        boot, poll loop, tabs, the one-second clock
vendor/leaflet/  Leaflet 1.9.4 (MIT), vendored deliberately - see the bus detail
                 view below
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

**Manual per-row refresh.** Each arrival row carries a small refresh button
(`js/ui-stop.js`'s `requestRefresh`/`.row-refresh`). There is no per-vehicle
endpoint — `/vehicles` is the whole feed or nothing — so under the hood every
tap is the same full `SB.app.pollNow()` the automatic loop uses; the button
just gives the user an immediate one instead of waiting up to 15s. A shared
`REFRESH_COOLDOWN_MS` (5s) across every row's button stops a curious multi-tap
turning into a burst of requests against an undocumented API, and a
`REFRESH_TIMEOUT_MS` backstop (10s) clears a stuck spin if `sb:poll-settled`
(dispatched from both branches of `app.js`'s `poll()`) is ever missed. Clearing
happens for *every* currently-spinning row on any settle, correctly, because
the underlying fetch is one shared feed — there is no way for one row's tap to
resolve without every row's data also being current.

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

**THE CRITICAL LIMIT, measured repeatedly, from multiple angles, on different
days: TripUpdates is a live operational feed, not a published timetable.**
Trip-level: at 18:26, 5 of 1472 today-trips had a future start time; at 21:23,
3 of 3013. It lists trips already dispatched, not a coming schedule. Endpoint
level: 12 candidate REST paths on Modeshift all 404, and JSP's own web bundle
references only five transit endpoints (`planner/routes`, `planner/stops`,
`planner/plan`, `gtfsrt/alerts`, `planner/vehicles`) — no timetable endpoint
exists there at all. Catalog level: neither transit.land nor
mobilitydatabase.org lists a Skopje or JSP operator, and no GTFS static zip
exists at any plausible URL on jsp.com.mk or skopjebus.mk (checked directly,
all 404). A decade-old academic GTFS conversion of JSP's data exists in
research papers but was never publicly hosted and is not maintained. **A full
forward timetable cannot be built from this API or found anywhere else
reachable. Do not add one without a genuinely new, verified data source** — and
verify it the same way: check it actually answers "what departs in the next
40 minutes that hasn't left yet", not just that a page mentions GTFS.

Given that, what `js/timetable.js` can honestly do splits into two different
questions, and — see the September revision below — they must not be mixed
into one list:
- **"What's still to come?"** (`upcomingForStop`) — only the rare trips this
  rolling feed happens to catch before they depart. Usually few or none.
- **"What's running dark?"** (`runningWithoutGps`) — trips already dispatched
  with no live vehicle. Real, useful, but a different question with a
  different answer, shown only in the Information tab's count.

What the near/far live split in `ui-stop.js` does (below) is extend the stop
view past `eta.js`'s old `MAX_STOPS_AWAY` cap — a real gain, and unrelated to
either of the above, since it needs no schedule data at all.

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

**Third revision: `upcomingForStop` now returns only not-yet-departed trips.**
It originally also included already-departed, no-GPS trips (labelled
`no_signal`), reasoning that a dispatched-but-dark bus is still real
information. In practice that meant the main stop screen's "coming within the
hour" list was dominated by buses that had **already left** — exactly the
complaint that came back: "you're giving me the ones that already departed;
give me the ones still coming." That complaint is the direct, predictable
consequence of the data limit above (rarely-populated advance data, commonly-
populated dispatched-trip data), not a bug in how the two were being
combined — so the fix is not a smarter merge, it is **not merging them**:
`upcomingForStop` now filters strictly on `nowMin < t.startMin` and drops
`no_signal` (and the `state`/`started`/`tracked` fields that existed to
distinguish it — every row here is now unconditionally "not yet departed", so
`тргнува` is used, not the neutral `по ред`). The already-departed-dark
question still has a real, honest answer — `runningWithoutGps`, unchanged,
still feeding the Information tab's "тргнати без ГПС сигнал" count — it is
just no longer answered on the same screen as "what's still coming", because
those are different questions and conflating them is what caused the
complaint. **`HORIZON_MIN` is 40, not 60**, per the same follow-up: the user
asked for an hour first, then asked for 40 minutes once they had seen what an
hour of this data actually looks like.

`rendered` and `live` are still **different sets**, independently of the above,
and conflating THEM was an earlier, separate bug: eta.js stops at its range
cap, so a tracked bus can be absent from the list, and treating "absent" as
"untracked" made 7 of 8 rows falsely claim `нема сигнал од возилото`. Dedupe
against what eta.js *rendered*; decide tracked-ness from the *live vehicle
list*. `upcomingForStop` takes both, and still needs to given the live-position
short-circuit that remains in the function.

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

### The bus detail view (`js/ui-detail.js`)

**Third revision: replaces the old always-on "every bus in Skopje" map tab.**
That tab showed 100+ markers at once, most of which nobody was looking for, and
had no way to leave it except the bottom tab bar — which itself came back as a
complaint ("no button to close the map"). Both problems share one fix: there is
no longer a standing map screen at all. Tapping any arrival row opens a
full-screen view of **exactly that one bus**, with its own small map, and the
only way onto that screen is a tap - so the back arrow at its top is the only
way anyone needs to leave it. `js/ui-map.js` is deleted; nothing else replaced
its "watch every bus" job, because the user explicitly asked for the opposite
of that ("не мора сите автобуси да се покажуваат во целото време - туку само
тој кој јас сум го кликнал").

**Identity across polls.** `arrivals` is a brand-new array every poll (built in
`ui-stop.js`), so this module cannot hold onto the row object it was opened
with - it holds onto `tripId` instead (present on every row, live, far or
scheduled) and re-finds the freshest matching row out of whatever `update()`
is handed each time, called from the tail of `ui-stop.js`'s `onData()`
unconditionally (it no-ops in one line if closed). That re-find is also what
lets a row quietly turn from "predicted, no GPS yet" into a live one without
this screen needing to know or care which kind it started as - it is simply
whatever `js/eta.js`/`js/timetable.js` currently say about that `tripId`.

**The map is a singleton**, unlike the old tab's mount/unmount cycle: created
once on first `open()` and reused for every later one (`setView` + swap
markers), never destroyed. There is exactly one place this screen can be
shown, so the double-init class of bug the old tab had to guard against
(`mounting` flag, tapping away and back while Leaflet was still loading)
cannot occur here by construction.

Leaflet is still **vendored** in `vendor/leaflet/`, not loaded from a CDN,
because `sw.js` deliberately ignores cross-origin GETs — a CDN copy could
never be precached and the map would be dead offline. Still injected lazily on
first open so a user who never taps a row pays nothing at boot. The two
carried-over details that will be got wrong if changed carelessly:

- **Rotation must live on an inner span.** Leaflet rewrites `transform` on the
  marker's root element on every `setLatLng`, pan and zoom, so a heading applied
  to the root is silently erased each poll. `.bus-pin` is the root Leaflet owns;
  `.bus-arrow` is ours.
- **`#panel-detail[hidden]` needs `display:none !important`.** Toggled directly
  by `ui-detail.js`, not through the `TABS` system, but the same UA-stylesheet-
  loses-to-author-`display:flex` problem applies. Without it the overlay covers
  the app permanently.

Honesty rules, carried over and extended for the single-bus case: the marker
tweens 1.2s between two genuinely reported positions and then stops -
dead-reckoning along `heading`/`speed` would be drawing a position nobody
reported. Null heading (or near-zero speed) gets a plain dot, not an invented
north-pointing arrow. **A bus whose `tripId` drops out of the merged arrivals
entirely (arrived, passed the stop, or lost GPS) does not vanish silently** -
the screen says so explicitly ("веројатно ја помина постојката или изгуби ГПС
сигнал") and leaves its last-known marker on the map, restyled `.is-stale`,
rather than either freezing it looking fresh or yanking it away. A scheduled
(not-yet-departed) row's tap works too, showing only the stop marker with a
note that there is no live position yet - it does not pretend a bus is
somewhere it has not reported being.

### The header icons and the favourite heart

**Third revision.** Инфо moved from a bottom tab to a small gear icon in the
header's top-right corner (`#btn-settings`) - it is still wired through the
exact same `TABS` machinery in `app.js` as before (`TABS.info.btn` just points
at the new element), so `showTab('info')`, the panel hide/show, and the
`aria-pressed` highlighting all work unchanged with zero special-casing. The
bottom tab bar is down to two: Постојка, Најди.

"Зачувај" and "Постави како почетна" (two buttons) became one heart icon
(`.heart-btn`, toggles `SB.store.toggleFavourite`). The separate "pin as home
stop" concept has no UI any more - `chooseInitialStop()` in `app.js` already
fell back to the first favourite when nothing was pinned, so favouriting a stop
is sufficient to make it the one that opens first; `store.js`'s
`pinnedStopId`/`setPinnedStop` are left in place (harmless, still read on boot)
rather than ripped out, since removing a working fallback path is not what was
asked for.

### Manual refresh, centralised

Every arrival row, and the bus detail view, carries its own refresh icon. There
is no per-vehicle endpoint - `/vehicles` is the whole feed or nothing - so
every tap, wherever it is pressed, ends up calling the exact same `poll()`.
The cooldown against turning enthusiastic tapping into a burst of requests
against an undocumented API therefore lives in **one place**,
`SB.app.requestManualRefresh()` in `app.js` (a 5s shared window), rather than
being duplicated per button; both `ui-stop.js`'s row buttons and
`ui-detail.js`'s button are thin callers that show a spin state and a
"Веќе е освежено пред кратко." toast on the `false` return. Each button also
carries its own 10s spin-timeout backstop, independent of the others, so a
missed `sb:poll-settled` event can never leave one specific button stuck
spinning forever.

One related fix worth noting: a row's tap target used to close over the
arrival object from whenever the row was last *built* (`buildRow`), not last
*painted* - since `paintRow` updates the visible text every poll without
rebuilding the row when its key is unchanged, a row sitting still for several
polls would open the detail view (or, before that concept existed, would have
used) data up to several poll cycles stale. `paintRow` now refreshes
`rows.get(key).data` on every call, so a tap always reads what is currently on
screen.

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
- **`sw.js`'s install handler fetches ASSETS one at a time (`ASSETS.reduce`
  chaining a promise), not `cache.addAll()` and not `Promise.all()`.** This was
  forced by a real, reproducible finding, not a style choice: in the automated
  browser tool used to verify this app, firing all ~25 precache requests from
  inside the service worker at once (either via `addAll()` or `Promise.all()` +
  `fetch()`/`cache.put()`) consistently left a stable subset of the list (not
  random - the same later entries every time) never persisted, *while the
  service worker registration still reported `active.state === 'activated'`* -
  which per spec should only be reachable once `install`'s `event.waitUntil`
  promise has resolved, i.e. once every asset supposedly finished. The identical
  fetches, issued from the PAGE instead of the service worker, succeeded
  instantly and completely (25/25) every single time, ruling out the dev server
  or the asset list. Going strictly one fetch at a time sidesteps whatever this
  is; for 25 small files the serial cost is negligible either way. **This
  specific check could not be made to pass reliably inside that automated
  tool even with the safest possible code** - `active.state === 'activated'`
  was observed with the cache anywhere from 0 to 25 of 25 items actually
  present, non-deterministically, across otherwise-identical runs. The app's
  normal (online) behaviour was confirmed unaffected either way - the `fetch`
  handler's cache-miss path falls through to the network correctly regardless
  of what precached. **Do not trust that automated tool's read of `caches.keys()`
  after a `register()` call as proof of a service-worker regression** - verify
  precaching by hand in a real browser's DevTools → Application → Cache Storage
  instead, which is also the only way to see errors thrown inside the worker's
  own execution context (its `console.log` does not reach the page's console,
  and `postMessage`/`MessageChannel` replies from the worker were also observed
  to never arrive back in that same automated tool, confirmed with a trivial
  throwaway test worker that did nothing but echo one message).

## Design rules

No purple gradients, no pill-shaped buttons, no emoji as icons, no em dashes in
UI copy, no heavy scroll animation. One accent colour, used only for the live
signal. These are standing constraints, not preferences.

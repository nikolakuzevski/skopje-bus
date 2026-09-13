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
| `transport/planner/stops/{id}/times` | that stop's remaining scheduled departures today, GPS-corrected where tracked | ~5 KB, ~500 ms — see js/timetable.js |
| `transport/gtfsrt/tripupdates` | GTFS-RT trips | **12 MB, ~1.2s**, no server-side filter; superseded by the row above, kept only as a documented dead end |
| `transport/gtfsrt/alerts?mediaType=WebPortal` | service alerts | tiny, unused so far |

**This API is undocumented and can change or close without notice.** That is the
main standing risk. Every URL and every upstream field name is normalised inside
`js/api.js` so a break is a one-file fix; nothing else in the codebase ever sees
a raw upstream field.

Two upstream quirks worth knowing before trusting a field:

- The plain `/vehicles` list calls the bus's next stop `stopId`, while
  `/vehicles/route/N` calls the identical thing `currentStopId`. `api.js`
  collapses both to `nextStopId`.
- In `tripupdates`, `arrival.time` is always `0`. This app no longer reads this
  endpoint at all — see the "per-stop timetable" section below for why, and for
  the correction to what used to be claimed here about no advance schedule
  existing. It stays in the table above only as a documented dead end.

## Architecture

```
js/dom.js        el() helper, icon() svg builder, in-app confirm, haversine, Macedonian formatting
js/api.js        the ONLY file that knows Modeshift; normalises at the boundary
js/cache.js      IndexedDB kv + the routes/stops snapshot and its lookup indexes
js/store.js      the ONLY file that touches localStorage (preferences only)
js/history.js    learned stop-to-stop travel times
js/eta.js        the prediction engine for buses with live GPS
js/timetable.js  per-stop scheduled departures (see transport/planner/stops/{id}/times)
js/debug.js      predicted-vs-actual accuracy measurement
js/push.js       "notify me" - subscribes this device to real Web Push for one stop
js/ui-stop.js    the main screen: one stop, every bus coming to it
js/ui-detail.js  full-screen view of ONE tapped bus, with its own small map
js/ui-pick.js    stop search
js/ui-info.js    settings + accuracy figures, opened from the header gear icon
js/app.js        boot, poll loop, tabs, the one-second clock
vendor/leaflet/  Leaflet 1.9.4 (MIT), vendored deliberately - see the bus detail
                 view below
api/subscribe.js Vercel serverless function - saves/removes a push subscription
api/check.js     Vercel serverless function - the actual notifier, cron-triggered
api/_lib/        shared helpers for the two functions above (not routes themselves)
```

The `api/` folder is this app's only server-side code, and it exists for exactly
one reason: push notifications need something checking bus positions even when
nobody has the app open, which a static page cannot do by itself. See "Push
notifications" below before touching anything under `api/`.

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

### The per-stop timetable (`js/timetable.js`)

**Fourth revision — supersedes everything this section used to say.** Earlier
revisions were built entirely on `transport/gtfsrt/tripupdates` (12 MB, a
rolling record of dispatched trips, `arrival.time` always 0) because that was
the only schedule-shaped endpoint a systematic survey had found: 12 candidate
REST paths all 404, JSP's own web bundle referenced no timetable endpoint, and
no GTFS static feed existed at any plausible URL or in any public catalog. That
survey was real and its numbers were real, but its conclusion — **"JSP does not
publish an advance timetable anywhere reachable"** — was wrong. It had not been
found, which is a different claim, and this file stated the stronger one
anyway. Worth remembering next time a "this data does not exist" conclusion
gets written down: it means "not found by the methods tried," not "absent."

**What actually found it**: a user report that a stop showed only ~2 buses
where the official app showed more. The live-position logic was instrumented
and audited stop by stop and found to be correct on its own terms (0 pattern
mismatches across 150+ live vehicles, busy stops correctly returning 6-42
arrivals) — the 2-bus count for the reported stop was also correct, given only
currently-dispatched buses to work from. That correctness was the tell: the
complaint wasn't a bug in the logic, it was a ceiling built into the data
source. Comparing the official skopjebus.mk site's own network traffic for the
same stop (not another guess at a URL) turned up
`transport/planner/stops/{id}/times` — every remaining scheduled departure for
the rest of the service day, not just dispatched trips, each carrying a
`realtime` flag and, when true, a GPS-measured `arrivalDelay` in seconds. For
the reported stop it returned 19 departures. ~5 KB, ~500 ms.

**Trusted only after a real cross-check, not on the strength of looking
official.** For 39 (stop, realtime-trip) pairs across four busy stops,
upstream's `scheduledArrival + arrivalDelay` was compared against this app's
own independent live-position estimate (`js/eta.js`) for the identical trip
and stop. Close in — a few stops out — the two agreed within a couple of
minutes, the same ballpark as `eta.js`'s own measured accuracy there. Far in (a
trip still 15-20+ stops from the target) they diverged by 5-20 minutes, which
reads as both sources doing the same kind of long-range extrapolation and
disagreeing, not as one being wrong — and it is the same region the *old*
`ERROR_CURVE` also refused to put a number on. That agreement pattern is what
justified switching the schedule source to this endpoint rather than just
adding it as one more field.

**Design consequence: this is now per-stop, not per-day.** At 12 MB the old
feed forced a whole-network download, cached once and reused, with all the
staleness bookkeeping that implies (`SNAPSHOT_TTL_MS`, `isFresh()` vs.
`isLoaded()`, the empty-snapshot-after-midnight trap). At 5 KB for a busy stop,
none of that scales-to-fit reasoning applies: `js/timetable.js` now fetches
and caches per `stopId` (`ensureForStop`), refetched on a 60s TTL while that
stop is on screen, fired on stop selection and re-fired whenever the cache
lands (`sb:timetable` event, listened for in `ui-stop.js` so a freshly opened
stop does not wait for the next 15s vehicles poll to show its schedule rows).
There is no explicit "download the timetable" action any more, no
`saveData`-gated big fetch, and no whole-network "buses running with no GPS"
count — that stat's data source (a full-network view) no longer exists in this
design, and nobody asked for it specifically; it was a side effect of the old
architecture, not a request. Dedup against `eta.js`'s live rows is unchanged
in spirit: `upcomingForStop` still drops any trip already present in
`renderedArrivals` by `tripId`, because a live GPS anchor beats a schedule
estimate every time.

**Absolute times, not the old departure-time-plus-traversal hack.** The old
design's only anchor was a trip's start time; everything past that was this
app's own segment-by-segment guess (`history.js` learned times, falling back to
haversine distance). `scheduledArrival` on this endpoint is already the time
AT THE TARGET STOP, upstream's own figure — `traversalSeconds`,
`patternLookup`, and the whole tripUpdates-reduction pipeline (`reduce`,
`index`, `byStop`) are gone, not because they were wrong, but because the thing
they existed to approximate is now given directly.

**Uncertainty margins are a deliberate downgrade in confidence, not a measured
curve — see the code comment on `MARGIN_REALTIME_MIN`/`MARGIN_NEAR_MIN`/
`MARGIN_MID_MIN` in `js/timetable.js`.** The old `ERROR_CURVE` was measured
against the old source; reusing its numbers for a different upstream source
would be exactly the kind of unverified figure this project exists to avoid.
`realtime: true` rows get a tight band (justified by the cross-check above);
`realtime: false` rows get conservative, unmeasured bands that shrink to
nothing past `MID_HORIZON_MIN` (30 min out), where only the clock time is
shown. Once `js/debug.js` has accumulated enough predicted-vs-actual samples
specifically sourced from this endpoint, these bands should be replaced with
measured ones the same way `ERROR_CURVE` originally was — this is a documented
placeholder, not a finished number. `HORIZON_MIN` stays 40, unchanged from the
prior revision, per the same user follow-up that set it there.

The near/far live split in `ui-stop.js` is unaffected by any of this — it
extends the stop view past `eta.js`'s `MAX_STOPS_AWAY` cap using only the live
feed, and needs no schedule data at all.

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

**Tapping the bus marker itself** answers "is it moving right now, and how
fast" via a popup (`movementText`/`busPopupHtml`). `STOPPED_AT` (upstream's own
stronger claim) is trusted over the raw `speed` figure when both are present;
`speed` below 0.6 m/s reads as stationary rather than "moving" on GPS jitter
near a red light; a missing `speed` says so ("непозната брзина") rather than
guessing. The popup's content is rebuilt fresh on every click from whatever
`lastRow` currently is, not baked in when the marker was created, since speed
and status change every poll while the marker object itself is reused.

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

## Push notifications (`js/push.js`, `sw.js`, `api/`)

The first, and so far only, reason this app has any server-side code at all.
Everything else in this project is a static page calling JSP's API directly
from the browser - deliberate, see "The data source" above. Notifications
broke that: a countdown computed in `eta.js`/`timetable.js` only exists while
the tab is open and the screen is on, because mobile browsers suspend a
backgrounded tab's JS almost immediately (this app's own poll loop already
relies on that being true - `document.hidden` stops polling on purpose, to
save battery). Locking the phone or leaving the app stops everything. A
notification that has to fire *without* the app open needs something running
independently of the app - a server, checking on its own schedule.

**Single-stop by design.** A browser holds at most one `PushSubscription` per
origin at a time, so this does not pretend to watch several stops per device -
subscribing to a new stop silently replaces whichever one was being watched
before, both in the browser and on the server. A bell icon in the stop header
(`js/push.js`, next to the favourite heart) toggles it for whichever stop is
currently on screen.

**Notifies only from `realtime: true` schedule entries** - a GPS-tracked,
already-dispatched trip, from the same `transport/planner/stops/{id}/times`
endpoint `js/timetable.js` already uses. Deliberately not a not-yet-dispatched
trip's schedule-only estimate: this project spent real effort establishing
that a not-yet-dispatched prediction should be stated as a plain scheduled
clock time, not a countdown, because nothing live backs it yet (see the
per-stop timetable section above) - sending a phone notification off that same
untrustworthy number would undo that work. `NOTIFY_THRESHOLD_MIN` in
`api/check.js` (3 minutes) matches the "already started" case the accuracy
work above was about.

**Where each piece lives:**

- `js/push.js` — asks for notification permission, creates the browser's
  `PushSubscription` (keyed to a VAPID public key baked into this file - public
  by design, the counterpart to a private key that never leaves the server),
  and POSTs/DELETEs it to `api/subscribe.js`. Nothing in this file decides
  *when* to notify; it only ever sets up or tears down the subscription.
- `sw.js`'s `push` and `notificationclick` listeners — display whatever
  `api/check.js` sends and focus/open the app on tap. `tag: 'sb-arrival'` +
  `renotify: true` replace any still-showing notification instead of stacking
  one, since only one stop is ever being watched per device.
- `api/subscribe.js` — a Vercel serverless function. Saves or removes one
  subscription (keyed on `endpoint`, which is unique per browser+device) in
  the store below.
- `api/check.js` — a Vercel serverless function, and the only piece that
  actually decides to notify. For every subscribed stop, fetches its
  `realtime: true` entries, and for any due within `NOTIFY_THRESHOLD_MIN` that
  this (subscription, tripId) pair has not already been notified about, sends
  a push via the `web-push` npm package (hand-rolling Web Push's
  ECDH+HKDF+AES128GCM payload encryption would be real cryptography code this
  project has no business writing itself). **Not triggered by Vercel's own
  cron** - Hobby-tier Vercel cron only runs once a day, useless for a 3-minute
  threshold. `.github/workflows/notify-check.yml` calls it instead, every 5
  minutes (GitHub Actions' own minimum interval), free because this repo is
  public. Guarded by a `CRON_SECRET` header so the endpoint cannot be
  triggered, probed, or used to burn through push-send quota by anyone who
  finds the URL - both the deployment and its source are public.
- **The subscription store is a single private GitHub Gist**, read and
  rewritten whole on every call (`api/_lib/gist.js`). This is a personal app
  with a handful of subscribed devices, not a product with many users - a real
  database would be more infrastructure than the data justifies, and reusing
  the GitHub auth this environment already had avoided asking for yet another
  account. Would need revisiting (a real DB, or at least per-key writes
  instead of whole-file rewrites) well before this could serve more than a
  personal handful of devices - noted here so nobody mistakes it for a
  considered choice at any larger scale.

**Secrets, none of them in this public repo:** `VAPID_PUBLIC_KEY` is baked
into `js/push.js` directly (it is meant to be public). Everything else -
`VAPID_PRIVATE_KEY`, `GIST_ID`, `GIST_TOKEN`, `CRON_SECRET` - lives only in
Vercel's project environment variables and the GitHub Actions repo secret,
never committed. If any of these need rotating, that happens in the Vercel
dashboard / `gh secret set`, not in code.

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

**Note on the four bullets above referencing `runningWithoutGps()`,
`wallClockMinutes`/`wallClockInstant`, and `dayStamp`**: all describe real bugs
fixed in the tripUpdates-based design that the "per-stop timetable" section
above replaced. None of that code exists any more — the per-stop endpoint gives
absolute times directly, so there is no elapsed-time arithmetic left to have a
DST bug, and no whole-network snapshot left to outlive a service day. Left here
rather than deleted, per this file's own convention of keeping a fix's account
even after the code it fixed is gone.

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

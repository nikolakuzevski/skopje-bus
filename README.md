# Автобус Скопје

A faster, more honest live-arrivals app for Skopje's buses. Opens straight to
your stop and tells you when the next bus really gets there.

Built because the official JSP app gets three things wrong: the countdown jumps
around and hits zero at empty stops, buses turn up that it never listed, and it
takes too long to answer one question.

## What it does differently

**The countdown does not jump.** It holds a predicted arrival *time* and ticks
down from your phone's clock. Each refresh nudges that time rather than
replacing it, so ordinary noise in the feed never reaches the screen, while a
real change still shows up at once. Measured: with the upstream estimate
bouncing across a 38-second range, the number on screen stayed inside 8 seconds.

**It admits when it does not know.** If a bus has not reported its position for
90 seconds, the countdown stops and the row says "нема сигнал" with the age.
Buses more than five stops away show a range, not a fake exact minute.

**It shows buses that are still far away.** Not just the next few stops: buses
up to forty stops up the line appear too, with a wide range rather than a fake
exact minute. This needs no download and is always on.

**You can refresh a bus the moment you want to.** Every row has its own
refresh button. There is no way to ask the source for just one bus's position,
so it re-fetches everything, but that row is the one you tapped, and it lands
immediately instead of waiting out the rest of the poll interval.

**Buses that haven't left yet, shown honestly.** Any bus due at your stop
within 40 minutes shows up automatically, pulled from JSP's real per-stop
schedule (fetched fresh for whichever stop you're looking at). A trip that
hasn't been dispatched yet shows its scheduled time plainly ("во 11:00 · се
очекува") rather than a guessed countdown. Once it's actually out on the road
and GPS-tracked, it switches to a single accurate minute count plus whether
it's running on time, late, or early — never a wide range, and always rounded
toward the earlier side, so checking a little early beats missing it. It never
mixes in already-departed buses just to look fuller.

**It can notify you, even with your phone locked.** Tap the bell next to a
stop's name and it'll send a real push notification when a GPS-tracked bus is
about to arrive there — this works even if the app isn't open, which an
in-page countdown never could. One stop watched per device at a time; picking
a new one replaces the old.

**Tap a bus to watch just that one.** No standing map of every bus in the
city — tap any row and it opens full screen: minutes to arrival, how many
seconds ago its position last updated, a refresh button, and a small map with
that bus and your stop on it. Positions are roughly half a minute old and the
screen says so. Close it and it's gone; nothing keeps watching in the
background.

**It learns your routes.** While open, it times how long buses actually take
between stops and uses that instead of a generic estimate. This gets better the
more you use it, on exactly the lines and hours you travel.

**It is honest about its own accuracy.** The Information tab shows the average
error of its own past predictions, measured against when buses actually arrived.

## Running it

```bash
powershell -ExecutionPolicy Bypass -File dev-server.ps1
```

Then open <http://localhost:8000/>. Opening `index.html` directly as a file will
not work: the service worker and location access both need a real HTTP origin.

Install it on a phone with "Add to Home screen". It then opens standalone and
the interface loads instantly from cache even with no signal, though live
arrival data obviously needs a connection.

## Where the data comes from

The same source JSP's own app and website use. It is not an officially published
API, so it can change or stop working without warning. If that happens,
everything that touches it lives in `js/api.js`.

The map uses [Leaflet](https://leafletjs.com/) 1.9.4 (MIT), copied into
`vendor/leaflet/` rather than loaded from a CDN so the app keeps working
offline, with map tiles from OpenStreetMap.

This is a personal project and is not affiliated with JSP Skopje.

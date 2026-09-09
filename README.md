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

**Buses that haven't left yet, shown honestly.** Download the timetable from
the Information tab and any bus due to depart within 40 minutes shows up,
marked "предвидување". A limit worth knowing, and worth saying plainly: JSP
does not publish a forward timetable anywhere reachable — checked directly,
not assumed. Its feed only ever lists buses already dispatched, so most of the
time this list will be short or empty, and that is the real data talking, not
a broken feature. It never mixes in already-departed buses just to look fuller
— those get counted separately, honestly, on the Information tab instead.

**A map.** Watch the buses move across Skopje, with line numbers and which way
each one is pointing. Buses serving your stop are highlighted. Positions are
roughly half a minute old and the map says so rather than pretending otherwise.

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

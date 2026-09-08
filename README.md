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

**It can find the buses that are missing.** Some buses run without sending a
position and never appear in any app. Download the timetable from the
Information tab and they show up, marked "предвидување" because that is what
they are, along with buses that have not left their terminus yet.

A limit worth knowing: JSP does not publish a forward timetable through this
API. Its feed lists buses already dispatched, not the coming hour's departures,
so what you get is a snapshot that stays useful for about half an hour rather
than a schedule for the day. The app says how old it is instead of pretending
otherwise. Inventing the rest would defeat the point.

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

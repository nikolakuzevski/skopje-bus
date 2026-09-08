/* ui-stop.js — the main screen: one stop, every bus coming to it.
 *
 * Two update rates on purpose. The list structure is rebuilt only when the set
 * of approaching buses actually changes (roughly every poll, 15s), while the
 * countdown text is refreshed every second from the held arrival instant. That
 * is what makes the numbers tick down smoothly instead of lurching once per
 * poll, and it means nothing on screen moves unless something really changed. */
(function () {
  const SB = (window.SB = window.SB || {});
  const el = SB.dom.el;

  const FEED_STALE_MS = 90000;   // matches eta.js's per-vehicle staleness gate
  const NEAR_MAX_STOPS = 12;     // eta.js's own confident range
  const FAR_MAX_STOPS = 40;      // tracked, but far enough to need a wide range

  let stopId = null;
  let arrivals = [];
  let signature = '';
  const rows = new Map(); // key -> {li, timeText, timeSub, sub}

  /* Prefixed by kind so a trip that starts mid-session changes key, the list
   * signature changes with it, and the row moves from the scheduled group to
   * the live group instead of being repainted in place. */
  function key(a) {
    if (a.scheduled) return 's|' + a.tripId;
    return (a.far ? 'f|' : 'l|') + a.vehicleId;
  }

  function stopsAwayText(a) {
    if (a.scheduled) return SB.timetable.detail(a);
    if (a.stopsAway === 0) return 'следна постојка';
    if (a.stopsAway === 1) return '1 постојка до тука';
    return a.stopsAway + ' постојки до тука';
  }

  function delayText(a) {
    if (a.scheduled) return '';
    // -9999 is upstream's "unknown" sentinel; taken literally it reads as
    // 166 minutes early. It appears in the schedule feed, never in the live
    // one, but the guard is cheap and the failure is a visible lie.
    if (a.delaySeconds == null || a.delaySeconds === -9999) return '';
    if (Math.abs(a.delaySeconds) < 120 || Math.abs(a.delaySeconds) > 7200) return '';
    const mins = Math.round(Math.abs(a.delaySeconds) / 60);
    return a.delaySeconds > 0 ? ' · доцни ' + mins + ' мин' : ' · порано ' + mins + ' мин';
  }

  function renderHead() {
    const host = SB.dom.qs('#stop-head');
    if (!host) return;
    SB.dom.clear(host);

    const stop = stopId != null ? SB.net.stopById.get(stopId) : null;
    if (!stop) {
      host.appendChild(el('h2', { class: 'stop-name', text: 'Изберете постојка' }));
      host.appendChild(el('p', {
        class: 'stop-meta',
        text: 'Отворете „Најди постојка“ и изберете ја вашата.'
      }));
      return;
    }

    host.appendChild(el('h2', { class: 'stop-name', text: stop.name }));

    const bits = [];
    if (stop.code) bits.push('бр. ' + stop.code);
    const pos = SB.app && SB.app.lastPosition();
    if (pos) bits.push(SB.dom.fmtDistance(SB.dom.haversine(pos.lat, pos.lon, stop.lat, stop.lon)));
    host.appendChild(el('p', { class: 'stop-meta', text: bits.join(' · ') }));

    const isFav = SB.store.isFavourite(stop.id);
    const isPinned = SB.store.pinnedStopId() === stop.id;
    host.appendChild(el('div', { class: 'stop-actions' }, [
      el('button', {
        class: 'btn', type: 'button', 'aria-pressed': String(isFav),
        onclick: function () {
          SB.store.toggleFavourite(stop.id);
          renderHead();
          SB.dom.toast(SB.store.isFavourite(stop.id) ? 'Зачувано' : 'Отстрането');
        }
      }, isFav ? 'Зачувана' : 'Зачувај'),
      el('button', {
        class: 'btn', type: 'button', 'aria-pressed': String(isPinned),
        onclick: function () {
          SB.store.setPinnedStop(isPinned ? null : stop.id);
          renderHead();
          SB.dom.toast(isPinned ? 'Веќе не се отвора прва' : 'Оваа постојка се отвора прва');
        }
      }, isPinned ? 'Почетна' : 'Постави како почетна')
    ]));
  }

  function buildRow(a) {
    const timeText = el('span', { class: 'time-text' });
    const timeSub = el('span', { class: 'time-sub' });
    const sub = el('span', { class: 'arrival-sub' });
    const li = el('li', { class: 'arrival', dataset: { key: key(a) } }, [
      el('span', { class: 'route-badge', text: a.routeName }),
      el('span', { class: 'arrival-main' }, [
        el('span', { class: 'headsign', text: a.headsign || SB.net.routeName(a.routeId) }),
        sub
      ]),
      el('span', { class: 'arrival-time' }, [timeText, timeSub])
    ]);
    rows.set(key(a), { li: li, timeText: timeText, timeSub: timeSub, sub: sub });
    return li;
  }

  /* `feedAgeMs` is how long since the last SUCCESSFUL poll, which is not the
   * same as how old any one bus's GPS fix is. When the feed itself is down,
   * every row is counting down from an arrival instant nobody has confirmed
   * since — so the whole list freezes and says so, rather than ticking politely
   * to "сега" for a bus that may already have come and gone. */
  function paintRow(a, now, feedAgeMs) {
    const r = rows.get(key(a));
    if (!r) return;

    const feedDown = feedAgeMs != null && feedAgeMs > FEED_STALE_MS;
    let lbl;
    if (a.scheduled) {
      // A schedule row does not depend on the live feed, so a feed outage does
      // not make it any less true than it already was.
      lbl = SB.timetable.label(a, now);
    } else if (feedDown) {
      lbl = { text: 'нема податоци', sub: 'од пред ' + SB.dom.fmtAge(feedAgeMs / 1000) };
    } else {
      lbl = SB.eta.label(a, now);
    }

    r.timeText.textContent = lbl.text;
    r.timeSub.textContent = lbl.sub;
    r.sub.textContent = stopsAwayText(a) + delayText(a);
    r.li.className = 'arrival is-' +
      (a.scheduled ? 'predicted' : (feedDown ? 'stale' : (a.far ? 'far' : a.state)));
  }

  function feedAge() {
    return SB.app && SB.app.feedAgeMs ? SB.app.feedAgeMs() : null;
  }

  function renderList(now) {
    const host = SB.dom.qs('#arrivals');
    const empty = SB.dom.qs('#empty');
    if (!host) return;

    const sig = arrivals.map(key).join(',');
    if (sig !== signature) {
      signature = sig;
      rows.clear();
      SB.dom.clear(host);
      arrivals.forEach(function (a) { host.appendChild(buildRow(a)); });
    }
    const age = feedAge();
    arrivals.forEach(function (a) { paintRow(a, now, age); });

    if (empty) {
      if (arrivals.length) {
        empty.hidden = true;
      } else {
        empty.hidden = false;
        empty.textContent = stopId == null
          ? 'Изберете постојка за да ги видите доаѓањата.'
          : 'Ниту едно возило не е тргнато кон оваа постојка во моментов.';
      }
    }
  }

  SB.uiStop = {
    currentStopId: function () { return stopId; },

    setStop: function (id) {
      if (stopId === id) return;
      stopId = id;
      arrivals = [];
      signature = '';
      rows.clear();
      SB.dom.clear(SB.dom.qs('#arrivals'));
      renderHead();
      renderList(Date.now());
      if (SB.app) SB.app.pollNow();
    },

    /** Called by app.js after every successful poll. */
    onData: function (vehicles, now) {
      if (stopId == null) { renderList(now); return; }

      /* Two passes over the same live feed. The near pass is the confident
       * list; the far pass picks up buses that are genuinely tracked but still
       * many stops up the line, which the old cap hid entirely. This needs no
       * timetable download - it is the same 36 KB poll either way - so the
       * bulk of the hour-ahead view is free and always on. */
      const all = SB.eta.arrivalsForStop(stopId, vehicles, now, { maxStopsAway: FAR_MAX_STOPS });
      const live = [];
      const far = [];
      all.forEach(function (a) {
        if (a.stopsAway <= NEAR_MAX_STOPS) live.push(a);
        else far.push(Object.assign({}, a, { far: true }));
      });

      // The timetable adds only what the live feed cannot know: buses running
      // with no GPS, and trips that have not departed yet.
      const scheduled = SB.timetable.isFresh()
        ? SB.timetable.upcomingForStop(stopId, all, vehicles, now)
        : [];

      arrivals = live.concat(far, scheduled);
      // Only the confident near rows feed the accuracy stats, so the figures in
      // the Information tab keep measuring the live engine and are not diluted
      // by deliberately wide far or schedule ranges.
      SB.debug.recordPredictions(stopId, live, now);
      renderList(now);
    },

    /** Called once per second. Only touches text. */
    tick: function (now) {
      if (!arrivals.length) return;
      const age = feedAge();
      arrivals.forEach(function (a) { paintRow(a, now, age); });
    },

    refreshHead: renderHead,
    render: function () { renderHead(); renderList(Date.now()); }
  };
})();

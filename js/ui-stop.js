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

  /* A manual refresh on one row still refetches the whole feed - the API has
   * no way to ask for a single vehicle - so every row visibly updates from a
   * single tap, not just the one pressed. A short shared cooldown stops a
   * curious double-tap (or several rows tapped in a row) from turning into a
   * burst of requests against an undocumented API; REFRESH_TIMEOUT_MS is a
   * backstop so a button can never spin forever if a poll's settle event is
   * somehow missed (a hidden tab, a poll already in flight and swallowed). */
  const REFRESH_COOLDOWN_MS = 5000;
  const REFRESH_TIMEOUT_MS = 10000;

  let stopId = null;
  let arrivals = [];
  let signature = '';
  const rows = new Map(); // key -> {li, timeText, timeSub, sub, refreshBtn}
  let lastManualRefreshAt = 0;
  const refreshing = new Set(); // row keys currently showing the spin state

  function refreshIcon() {
    return el('span', {
      class: 'refresh-icon',
      html: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">' +
        '<path fill="currentColor" d="M8 2.5a5.5 5.5 0 1 0 5.163 3.6.75.75 0 0 1 1.406-.53A7 7 0 1 1 8 1v-.9a.35.35 0 0 1 .57-.27l2.4 1.9a.35.35 0 0 1 0 .55l-2.4 1.9A.35.35 0 0 1 8 3.9V2.5Z"/>' +
        '</svg>'
    });
  }

  function stopSpinning(key) {
    refreshing.delete(key);
    const r = rows.get(key);
    if (r && r.refreshBtn) {
      r.refreshBtn.classList.remove('is-spinning');
      r.refreshBtn.disabled = false;
    }
  }

  /* Fires once per settled poll, whoever triggered it - the timer, a
   * visibility resume, or one of these buttons. Clearing every spinning row
   * together (rather than tracking which tap caused which response) is
   * correct: the feed is a single shared fetch, so any settle means every
   * row's data is now as fresh as this tap could make it. */
  window.addEventListener('sb:poll-settled', function () {
    Array.from(refreshing).forEach(stopSpinning);
  });

  /* Prefixed by kind so a trip that starts mid-session changes key, the list
   * signature changes with it, and the row moves from the scheduled group to
   * the live group instead of being repainted in place. tripId is included
   * too: vehicleId alone is stable across a bus flipping to a different trip
   * (e.g. reaching a terminus and taking the return pattern), which used to
   * leave that row's badge and headsign frozen on the old trip because
   * buildRow only writes them once. */
  function key(a) {
    if (a.scheduled) return 's|' + a.tripId;
    return (a.far ? 'f|' : 'l|') + a.vehicleId + '|' + a.tripId;
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

  function requestRefresh(rowKey) {
    const now = Date.now();
    // Refreshing refetches the whole feed - there is no per-vehicle endpoint -
    // so this cooldown is shared across every row's button, not per-button.
    if (now - lastManualRefreshAt < REFRESH_COOLDOWN_MS) {
      SB.dom.toast('Веќе е освежено пред кратко.');
      return;
    }
    lastManualRefreshAt = now;
    refreshing.add(rowKey);
    const r = rows.get(rowKey);
    if (r && r.refreshBtn) {
      r.refreshBtn.classList.add('is-spinning');
      r.refreshBtn.disabled = true;
    }
    setTimeout(function () {
      if (refreshing.has(rowKey)) stopSpinning(rowKey);
    }, REFRESH_TIMEOUT_MS);
    if (SB.app) SB.app.pollNow();
  }

  function buildRow(a) {
    const rowKey = key(a);
    const timeText = el('span', { class: 'time-text' });
    const timeSub = el('span', { class: 'time-sub' });
    const sub = el('span', { class: 'arrival-sub' });
    const refreshBtn = el('button', {
      class: 'row-refresh', type: 'button', 'aria-label': 'Освежи сега',
      onclick: function (e) { e.stopPropagation(); requestRefresh(rowKey); }
    }, [refreshIcon()]);
    const li = el('li', { class: 'arrival', dataset: { key: rowKey } }, [
      el('span', { class: 'route-badge', text: a.routeName }),
      el('span', { class: 'arrival-main' }, [
        el('span', { class: 'headsign', text: a.headsign || SB.net.routeName(a.routeId) }),
        sub
      ]),
      el('span', { class: 'arrival-time' }, [timeText, timeSub]),
      refreshBtn
    ]);
    rows.set(rowKey, { li: li, timeText: timeText, timeSub: timeSub, sub: sub, refreshBtn: refreshBtn });
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

    // The time column already says the data is old or gone; the sub-line
    // (stops-away, delay) is built from that same refused data and must say
    // so too, rather than reading as a confident present-tense position next
    // to a right-hand column admitting it is not current.
    const suppressed = !a.scheduled && (feedDown || a.state === 'stale');
    r.timeText.textContent = lbl.text;
    r.timeSub.textContent = lbl.sub;
    r.sub.textContent = (suppressed ? 'последно: ' : '') + stopsAwayText(a) + delayText(a);
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
        // "no bus is coming" is only true once a poll has actually confirmed
        // it. Before the first response, or with the feed down, this used to
        // assert it anyway - stated flatly, at boot, before any data exists.
        empty.textContent = stopId == null
          ? 'Изберете постојка за да ги видите доаѓањата.'
          : age == null
            ? 'Се вчитуваат доаѓањата.'
            : age > FEED_STALE_MS
              ? 'Нема податоци од изворот, последно пред ' + SB.dom.fmtAge(age / 1000) + '.'
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
       * timetable download - it is the same 36 KB poll either way - so it is
       * free and always on. */
      const all = SB.eta.arrivalsForStop(stopId, vehicles, now, { maxStopsAway: FAR_MAX_STOPS });
      const live = [];
      const far = [];
      all.forEach(function (a) {
        if (a.stopsAway <= NEAR_MAX_STOPS) live.push(a);
        else far.push(Object.assign({}, a, { far: true }));
      });

      // The timetable adds only trips not yet dispatched - what the live feed
      // genuinely cannot know. Already-departed, no-GPS trips are a different
      // question with a different answer; see js/timetable.js's header for why
      // they are not mixed in here.
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

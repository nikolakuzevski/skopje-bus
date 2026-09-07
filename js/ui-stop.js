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

  let stopId = null;
  let arrivals = [];
  let signature = '';
  const rows = new Map(); // key -> {li, timeText, timeSub, sub}

  function key(a) { return a.vehicleId + '|' + a.routeId + '|' + (a.untracked ? 'u' : 'l'); }

  function stopsAwayText(a) {
    if (a.untracked) return 'нема ГПС сигнал од возилото';
    if (a.stopsAway === 0) return 'следна постојка';
    if (a.stopsAway === 1) return '1 постојка до тука';
    return a.stopsAway + ' постојки до тука';
  }

  function delayText(a) {
    if (a.delaySeconds == null || Math.abs(a.delaySeconds) < 120) return '';
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

  function paintRow(a, now) {
    const r = rows.get(key(a));
    if (!r) return;
    const lbl = a.untracked
      ? { text: a.scheduledText || 'по возен ред', sub: 'без следење' }
      : SB.eta.label(a, now);
    r.timeText.textContent = lbl.text;
    r.timeSub.textContent = lbl.sub;
    r.sub.textContent = stopsAwayText(a) + delayText(a);
    r.li.className = 'arrival is-' + (a.untracked ? 'untracked' : a.state);
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
    arrivals.forEach(function (a) { paintRow(a, now); });

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
      const live = SB.eta.arrivalsForStop(stopId, vehicles, now);
      const extra = SB.untracked ? SB.untracked.forStop(stopId, now) : [];
      arrivals = live.concat(extra);
      SB.debug.recordPredictions(stopId, live, now);
      renderList(now);
    },

    /** Called once per second. Only touches text. */
    tick: function (now) {
      if (!arrivals.length) return;
      arrivals.forEach(function (a) { paintRow(a, now); });
    },

    refreshHead: renderHead,
    render: function () { renderHead(); renderList(Date.now()); }
  };
})();

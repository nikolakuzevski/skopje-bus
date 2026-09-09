/* ui-info.js — what the app knows and how well it has been doing.
 * The accuracy figures are the honest answer to "is this actually better than
 * the official app", so they are shown plainly rather than hidden behind a
 * debug flag. */
(function () {
  const SB = (window.SB = window.SB || {});
  const el = SB.dom.el;

  function dl(pairs) {
    const node = el('dl');
    pairs.forEach(function (p) {
      node.appendChild(el('dt', { text: p[0] }));
      node.appendChild(el('dd', { text: p[1] }));
    });
    return node;
  }

  function bucketRow(name, b) {
    if (!b.n) return [name, 'нема мерења'];
    const sign = b.biasSec > 0 ? '+' : '';
    return [name, b.meanAbsSec + ' сек (' + sign + b.biasSec + ', n=' + b.n + ')'];
  }

  function render() {
    const host = SB.dom.qs('#info-body');
    if (!host) return;
    SB.dom.clear(host);

    const acc = SB.debug.summary();
    const hist = SB.history.stats();
    const snapshotAge = SB.net.loadedAt ? (Date.now() - SB.net.loadedAt) / 1000 : null;

    host.appendChild(el('h2', { text: 'Точност на предвидувањата' }));
    host.appendChild(el('p', {
      text: 'Просечно отстапување од вистинското пристигнување, според тоа колку однапред е направено предвидувањето. Во заграда: просечна пристрасност, каде плус значи дека автобусот доаѓа подоцна од најавеното.'
    }));
    host.appendChild(dl([
      bucketRow('под 2 минути', acc.buckets.lt2),
      bucketRow('2 до 5 минути', acc.buckets.m2to5),
      bucketRow('над 5 минути', acc.buckets.gt5),
      ['вкупно мерења', String(acc.total)]
    ]));

    host.appendChild(el('h2', { text: 'Научени времиња' }));
    host.appendChild(el('p', {
      text: 'Апликацијата мери колку трае возењето меѓу две постојки додека е отворена. Додека нема доволно мерења, пресметката се потпира на растојание.'
    }));
    host.appendChild(dl([
      ['делници со мерења', String(hist.segments)],
      ['вкупно примероци', String(hist.samples)]
    ]));

    host.appendChild(el('h2', { text: 'Возен ред' }));
    host.appendChild(el('p', {
      text: 'Автобусите со ГПС сигнал секогаш се прикажуваат, и оние што се уште далеку по линијата. Ова преземање додава тргнувања што допрва следат во следните 40 минути (на постојката, означени „предвидување“), плус колку возила во моментов се во движење без ГПС сигнал (бројката подолу).'
    }));
    host.appendChild(el('p', {
      text: 'Важно: превозникот не објавува возен ред нанапред - неговиот систем пријавува само возила што веќе тргнале. Затоа тргнувања што допрва следат ретко се наоѓаат во податоците, дури и веднаш по преземање; кога ги нема, тоа значи дека моментално навистина ги нема во системот, не дека преземањето не успеало.'
    }));
    host.appendChild(el('p', {
      text: 'Преземеното важи околу половина час. Големо е околу 12 МБ, затоа не се прави автоматски.'
    }));

    const loaded = SB.timetable.isLoaded();
    const fresh = SB.timetable.isFresh();
    const loadBtn = el('button', { class: 'btn', type: 'button' },
      loaded ? 'Преземи повторно' : 'Преземи возен ред');
    loadBtn.addEventListener('click', function () {
      if (SB.timetable.saveDataOn()) {
        SB.dom.toast('Штедењето на интернет е вклучено, па возниот ред не се презема.', true);
        return;
      }
      loadBtn.disabled = true;
      loadBtn.textContent = 'Се презема';
      SB.timetable.refresh(Date.now())
        .then(function (trips) {
          SB.dom.toast(trips.length
            ? trips.length + ' тргнувања во возниот ред.'
            : 'Превозникот моментално не објавува ниту едно возило.');
          SB.app.repaintStop();
          // render() rebuilds this whole panel, including loadBtn itself, so
          // any write to loadBtn after this point would land on a node no
          // longer in the document. Reset it before rebuilding, not after.
          render();
        })
        .catch(function () {
          SB.dom.toast('Возниот ред не се презеде.', true);
          loadBtn.disabled = false;
          loadBtn.textContent = SB.timetable.isLoaded() ? 'Преземи повторно' : 'Преземи возен ред';
        });
    });
    host.appendChild(el('div', { class: 'stop-actions' }, [loadBtn]));

    if (loaded) {
      const noGps = SB.timetable.runningWithoutGps(SB.app.lastVehicles(), Date.now()).length;
      host.appendChild(dl([
        ['тргнувања во возниот ред', String(SB.timetable.tripCount())],
        ['тргнати без ГПС сигнал', String(noGps)],
        ['преземено пред', SB.dom.fmtAge((Date.now() - SB.timetable.loadedAt()) / 1000)],
        ['се уште важи', fresh ? 'да' : 'не, преземете повторно']
      ]));
    } else {
      host.appendChild(el('p', { text: 'Возниот ред не е преземен.' }));
    }

    host.appendChild(el('h2', { text: 'Поставки' }));
    const geoOn = SB.store.settings().useGeolocation;
    const geoBtn = el('button', {
      class: 'btn', type: 'button', 'aria-pressed': String(geoOn),
      onclick: function () {
        SB.store.setSetting('useGeolocation', !SB.store.settings().useGeolocation);
        render();
      }
    }, geoOn ? 'Вклучена' : 'Исклучена');
    host.appendChild(el('div', { class: 'row-toggle' }, [
      el('span', { text: 'Наоѓање најблиска постојка' }), geoBtn
    ]));

    host.appendChild(el('h2', { text: 'Податоци' }));
    host.appendChild(dl([
      ['постојки', String(SB.net.stops.length)],
      ['линии', String(SB.net.routes.length)],
      ['список освежен пред', snapshotAge == null ? 'непознато' : SB.dom.fmtAge(snapshotAge)],
      ['возила во живо', String(SB.app.lastVehicles().length)]
    ]));
    host.appendChild(el('p', {
      text: 'Податоците доаѓаат од истиот извор што го користи официјалната апликација на ЈСП. Изворот не е официјално отворен, па може да се промени без најава.'
    }));

    const actions = el('div', { class: 'stop-actions' }, [
      el('button', {
        class: 'btn', type: 'button',
        onclick: function () {
          SB.net.refresh().then(function () {
            SB.dom.toast('Списокот на линии е освежен.');
            // A manual refresh is also the recovery path if the poll loop
            // never got off the ground (e.g. it failed at boot before a retry
            // was in place). Restarting it here costs nothing when it is
            // already running - poll() no-ops while one is in flight.
            window.dispatchEvent(new CustomEvent('sb:network'));
            SB.app.pollNow();
            render();
          }).catch(function () { SB.dom.toast('Освежувањето не успеа.', true); });
        }
      }, 'Освежи линии и постојки'),
      el('button', {
        class: 'btn btn-danger', type: 'button',
        onclick: function () {
          SB.dom.confirm('Да се избришат мерењата за точност?').then(function (ok) {
            if (!ok) return;
            SB.debug.reset().then(render);
          });
        }
      }, 'Избриши мерења')
    ]);
    host.appendChild(actions);
  }

  SB.uiInfo = { mount: render, render: render };
})();

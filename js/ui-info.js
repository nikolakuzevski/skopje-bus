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

    host.appendChild(el('h2', { text: 'Возен ред за денес' }));
    host.appendChild(el('p', {
      text: 'Со возниот ред се прикажуваат и автобусите што допрва тргнуваат во следниот час, како и оние што се возат без ГПС сигнал. Се презема еднаш дневно, околу 12 МБ, затоа не се прави автоматски.'
    }));

    const loaded = SB.timetable.isLoaded();
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
          SB.dom.toast(trips.length + ' тргнувања за денес.');
          SB.app.repaintStop();
          render();
        })
        .catch(function () { SB.dom.toast('Возниот ред не се презеде.', true); })
        .then(function () {
          loadBtn.disabled = false;
          loadBtn.textContent = SB.timetable.isLoaded() ? 'Преземи повторно' : 'Преземи возен ред';
        });
    });
    host.appendChild(el('div', { class: 'stop-actions' }, [loadBtn]));

    if (loaded) {
      const noGps = SB.timetable.runningWithoutGps(SB.app.lastVehicles(), Date.now()).length;
      host.appendChild(dl([
        ['тргнувања денес', String(SB.timetable.tripCount())],
        ['во движење без ГПС', String(noGps)],
        ['преземено пред', SB.dom.fmtAge((Date.now() - SB.timetable.loadedAt()) / 1000)]
      ]));
    } else {
      host.appendChild(el('p', { text: 'Возниот ред за денес не е преземен.' }));
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

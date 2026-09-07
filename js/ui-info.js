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

    host.appendChild(el('h2', { text: 'Возила без ГПС' }));
    host.appendChild(el('p', {
      text: 'Дел од автобусите се возат, но не праќаат позиција, па не се појавуваат во листата. Оваа проверка ги бара во возниот ред во живо. Симнува околу 12 МБ, затоа не се прави автоматски.'
    }));
    const checkBtn = el('button', { class: 'btn', type: 'button' }, 'Провери');
    checkBtn.addEventListener('click', function () {
      if (SB.untracked.saveDataOn()) {
        SB.dom.toast('Исклучете „штедење на интернет“ за оваа проверка.', true);
        return;
      }
      checkBtn.disabled = true;
      checkBtn.textContent = 'Се проверува';
      SB.untracked.check(SB.app.lastVehicles())
        .then(function (list) {
          SB.dom.toast(list.length + ' возила без сигнал се во движење.');
          SB.app.repaintStop();
          render();
        })
        .catch(function (err) { SB.dom.toast(err.message || 'Проверката не успеа.', true); })
        .then(function () { checkBtn.disabled = false; checkBtn.textContent = 'Провери'; });
    });
    host.appendChild(el('div', { class: 'stop-actions' }, [checkBtn]));
    if (SB.untracked.lastCheckedAt()) {
      host.appendChild(dl([
        ['најдени', String(SB.untracked.count())],
        ['проверено пред', SB.dom.fmtAge((Date.now() - SB.untracked.lastCheckedAt()) / 1000)]
      ]));
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

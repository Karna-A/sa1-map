/*
 * SA1 print map.
 *
 * State lives in the URL so a map can be shared or bookmarked:
 *   ?sa1=21203130422:1234,21203130423&login=jsmith
 * (each code may carry its own PIN after a colon; login is printed on every page).
 *
 * Data is pre-split per SA2 (data/sa2/<9 digits>.json); an SA1 code's first 9 digits
 * are its SA2 code, so the file for any code is known without an index. The SA2
 * bbox index (data/sa2_index.json) is only used to load whatever is in view so the
 * surrounding SA1s can be drawn and clicked. districts.json holds the state district
 * boundaries; groups.json maps each seat and suburb to its SA1 codes for bulk printing.
 */
(function () {
  'use strict';

  var DATA = 'data/';
  var NEIGHBOUR_ZOOM = 13;       // load and draw surrounding SA1s from this zoom
  var LABEL_ZOOM = 15;           // show neighbour code labels from this zoom
  var DISTRICT_LABEL_ZOOM = 11;  // show district names from this zoom

  var STYLE_SELECTED = { color: '#d00', weight: 3, opacity: 1, fillColor: '#d00', fillOpacity: 0.08 };
  var STYLE_NEIGHBOUR = { color: '#777', weight: 1, opacity: 0.8, fillColor: '#000', fillOpacity: 0 };
  var STYLE_DISTRICT = { color: '#8c1515', weight: 3, opacity: 0.9, dashArray: '10 8', fill: false, interactive: false };
  var TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  var TILE_OPTS = { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' };

  var map = L.map('map').setView([-37.81, 144.96], 10);
  L.tileLayer(TILE_URL, TILE_OPTS).addTo(map);

  var selected = [];              // SA1 codes in the order they were entered
  var pins = {};                  // code -> PIN text for that SA1
  var login = '';                 // free text printed on every page (e.g. SwiftFox username)
  var sa1Layers = {};             // code -> Leaflet polygon layer (once its SA2 file is loaded)
  var sa2Data = {};               // SA2 code -> raw GeoJSON (re-drawn on the print pages)
  var sa2Loads = {};              // SA2 code -> Promise (dedupes fetches)
  var sa2Index = null;            // SA2 code -> [minlng, minlat, maxlng, maxlat]
  var districts = null;           // {lines: GeoJSON geometry, labels: [{name, lat, lng}]}
  var groups = null;              // {seats: {name: [codes]}, suburbs: {name: [codes]}}
  var printMaps = [];             // Leaflet maps created for the current print run

  var el = {};
  ['codes', 'apply', 'print', 'clear', 'seat', 'suburb', 'suburb-scope', 'login', 'status', 'count', 'selected-list', 'print-pages']
    .forEach(function (id) { el[id.replace(/-(\w)/g, function (_, c) { return c.toUpperCase(); })] = document.getElementById(id); });

  // ---------------------------------------------------------------- data loading
  function loadSa2(sa2) {
    if (!sa2Loads[sa2]) {
      sa2Loads[sa2] = fetch(DATA + 'sa2/' + sa2 + '.json')
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (geojson) {
          sa2Data[sa2] = geojson;
          L.geoJSON(geojson, { style: styleFor, onEachFeature: onEachSa1 }).addTo(map);
        })
        .catch(function () { /* no such SA2 (code outside VIC or mistyped): handled by the missing-code check */ });
    }
    return sa2Loads[sa2];
  }

  function styleFor(feature) {
    return selected.indexOf(feature.properties.sa1) >= 0 ? STYLE_SELECTED : STYLE_NEIGHBOUR;
  }

  function onEachSa1(feature, layer) {
    var code = feature.properties.sa1;
    sa1Layers[code] = layer;
    layer.bindTooltip(code, { permanent: true, direction: 'center', className: 'sa1-label', interactive: false });
    applyLayerStyle(code);
    layer.on('click', function (e) {
      L.DomEvent.stopPropagation(e);
      if (selected.indexOf(code) < 0) {
        selected.push(code);
        applyLayerStyle(code);
        el.status.textContent = '';
        syncUi();
      } else {
        askPin(code);
      }
    });
  }

  function labelFor(code) {
    return pins[code] ? code + '<br>PIN ' + escapeHtml(pins[code]) : code;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }

  function setTooltipClass(tooltip, cls) {
    tooltip.options.className = cls;
    var node = tooltip.getElement();
    if (node) node.className = 'leaflet-tooltip leaflet-zoom-animated ' + cls;
  }

  function applyLayerStyle(code) {
    var layer = sa1Layers[code];
    if (!layer) return;
    var isSel = selected.indexOf(code) >= 0;
    layer.setStyle(isSel ? STYLE_SELECTED : STYLE_NEIGHBOUR);
    if (isSel) layer.bringToFront();
    if (layer.getTooltip()) {
      layer.setTooltipContent(isSel ? labelFor(code) : code);
      setTooltipClass(layer.getTooltip(), 'sa1-label ' + (isSel ? 'selected' : 'neighbour'));
    }
  }

  // Load every SA2 whose bbox touches the viewport so neighbours can be seen and clicked.
  function loadViewport() {
    var z = map.getZoom();
    map.getContainer().classList.toggle('show-neighbour-labels', z >= LABEL_ZOOM);
    map.getContainer().classList.toggle('show-district-labels', z >= DISTRICT_LABEL_ZOOM);
    if (z < NEIGHBOUR_ZOOM || !sa2Index) return;
    sa2sInBounds(map.getBounds()).forEach(loadSa2);
  }

  function sa2sInBounds(b) {
    return Object.keys(sa2Index || {}).filter(function (sa2) {
      var x = sa2Index[sa2];
      return x[2] >= b.getWest() && x[0] <= b.getEast() && x[3] >= b.getSouth() && x[1] <= b.getNorth();
    });
  }

  // ---------------------------------------------------------------- selection
  // Accepts "code" or "code:pin" tokens separated by commas, spaces or new lines.
  function parseCodes(text) {
    var out = [];
    (text.match(/\d{11}(?::[^\s,]*)?/g) || []).forEach(function (tok) {
      var code = tok.slice(0, 11);
      if (out.indexOf(code) < 0) out.push(code);
      if (tok.length > 12) pins[code] = decodeURIComponent(tok.slice(12));
    });
    return out;
  }

  function setSelected(codes, zoomTo) {
    var previous = selected.slice();
    selected = codes;
    previous.forEach(applyLayerStyle);
    var sa2s = {};
    codes.forEach(function (c) { sa2s[c.slice(0, 9)] = true; });
    el.status.textContent = codes.length > 50 ? 'Loading ' + codes.length + ' SA1s…' : '';
    return Promise.all(Object.keys(sa2s).map(loadSa2)).then(function () {
      selected.forEach(applyLayerStyle);
      var missing = selected.filter(function (c) { return !sa1Layers[c]; });
      el.status.textContent = missing.length ? 'Not found in Victoria: ' + missing.join(', ') : '';
      syncUi();
      if (zoomTo) fitSelected();
    });
  }

  function removeSelected(code) {
    var i = selected.indexOf(code);
    if (i < 0) return;
    selected.splice(i, 1);
    applyLayerStyle(code);
    syncUi();
  }

  function setPin(code, value) {
    value = (value || '').trim();
    if (value) pins[code] = value; else delete pins[code];
    applyLayerStyle(code);
    syncUi();
  }

  function askPin(code) {
    var v = window.prompt('PIN for SA1 ' + code + ' (leave blank for none)', pins[code] || '');
    if (v !== null) setPin(code, v);
  }

  function selectedBounds() {
    var group = L.featureGroup(selected.map(function (c) { return sa1Layers[c]; }).filter(Boolean));
    return group.getLayers().length ? group.getBounds() : null;
  }

  function fitSelected() {
    var b = selectedBounds();
    if (b) map.fitBounds(b, { padding: [30, 30], maxZoom: 18 });
  }

  // ---------------------------------------------------------------- URL, sidebar list, textarea
  function token(code) {
    return pins[code] ? code + ':' + encodeURIComponent(pins[code]) : code;
  }

  function syncUi() {
    // Built by hand rather than URLSearchParams so the commas stay readable in the address bar.
    var parts = [];
    if (selected.length) parts.push('sa1=' + selected.map(token).join(','));
    if (login) parts.push('login=' + encodeURIComponent(login));
    history.replaceState(null, '', parts.length ? '?' + parts.join('&') : location.pathname);

    if (document.activeElement !== el.codes) el.codes.value = selected.join('\n');
    el.count.textContent = selected.length ? '(' + selected.length + ')' : '';

    el.selectedList.innerHTML = '';
    selected.forEach(function (c) {
      var props = sa1Layers[c] ? sa1Layers[c].feature.properties : null;
      var row = document.createElement('div');
      row.className = 'row' + (props ? '' : ' missing');
      var b = document.createElement('b');
      b.textContent = c;
      var place = document.createElement('div');
      place.className = 'place';
      place.textContent = props ? props.suburb + ' · ' + props.district : 'not found';
      var pin = document.createElement('input');
      pin.placeholder = 'PIN';
      pin.value = pins[c] || '';
      pin.title = 'PIN for ' + c;
      pin.addEventListener('change', function () { setPin(c, pin.value); });
      var x = document.createElement('button');
      x.type = 'button';
      x.textContent = '×';
      x.title = 'Remove ' + c;
      x.addEventListener('click', function () { removeSelected(c); });
      row.appendChild(b); row.appendChild(place); row.appendChild(pin); row.appendChild(x);
      el.selectedList.appendChild(row);
    });
  }

  function today() {
    return new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  function readUrl() {
    var params = new URLSearchParams(location.search);
    login = params.get('login') || '';
    el.login.value = login;
    return parseCodes(params.get('sa1') || '');
  }

  // ---------------------------------------------------------------- bulk pick (seat / suburb)
  function fillSeats() {
    Object.keys(groups.seats).forEach(function (name) {
      var o = document.createElement('option');
      o.value = name;
      o.textContent = name + ' (' + groups.seats[name].length + ')';
      el.seat.appendChild(o);
    });
    fillSuburbs('');
  }

  // With a seat chosen the suburb list shrinks to that seat's suburbs, and each
  // option carries the count of SA1s that are in BOTH the suburb and the seat.
  function fillSuburbs(seat) {
    el.suburb.innerHTML = '<option value="">Choose a suburb…</option>';
    el.suburbScope.textContent = seat ? '(within ' + seat + ')' : '(whole suburb)';
    var inSeat = seat ? toSet(groups.seats[seat]) : null;
    Object.keys(groups.suburbs).forEach(function (name) {
      var n = inSeat ? groups.suburbs[name].filter(function (c) { return inSeat[c]; }).length : groups.suburbs[name].length;
      if (!n) return;
      var o = document.createElement('option');
      o.value = name;
      o.textContent = name + ' (' + n + ')';
      el.suburb.appendChild(o);
    });
  }

  function toSet(codes) {
    var s = {};
    codes.forEach(function (c) { s[c] = true; });
    return s;
  }

  function pickSuburb(name) {
    var codes = groups.suburbs[name] || [];
    if (el.seat.value) {
      var inSeat = toSet(groups.seats[el.seat.value]);
      codes = codes.filter(function (c) { return inSeat[c]; });
    }
    setSelected(codes.slice(), true);
  }

  // ---------------------------------------------------------------- print: one page per SA1
  function loginLine(code) {
    var bits = [];
    if (login) bits.push(login);
    if (pins[code]) bits.push('PIN ' + pins[code]);
    return bits.length ? 'Login: ' + bits.join('  ·  ') : '';
  }

  function doPrint() {
    var codes = selected.filter(function (c) { return sa1Layers[c]; });
    if (!codes.length) { window.alert('Nothing to print: select at least one SA1 first.'); return; }
    if (codes.length > 60 && !window.confirm('Print ' + codes.length + ' pages (one per SA1)?')) return;

    document.body.classList.add('printing');
    el.printPages.innerHTML = '';
    printMaps = [];

    var remaining = codes.length;
    var fired = false;
    function tileLayerDone() { remaining -= 1; if (remaining <= 0) go(); }
    function go() {
      if (fired) return;
      fired = true;
      window.print();
    }

    codes.forEach(function (code) {
      var props = sa1Layers[code].feature.properties;
      var page = document.createElement('div');
      page.className = 'print-page';
      page.innerHTML =
        '<div class="pp-code"></div>' +
        '<div class="pp-sub"><span class="pp-date"></span><span class="pp-place"></span></div>' +
        '<div class="pp-login"></div>' +
        '<div class="pp-map"></div>';
      page.querySelector('.pp-code').textContent = code;
      page.querySelector('.pp-place').textContent = props.suburb + '  ·  ' + props.district + ' District';
      page.querySelector('.pp-date').textContent = today();
      page.querySelector('.pp-login').textContent = loginLine(code);
      el.printPages.appendChild(page);

      var m = L.map(page.querySelector('.pp-map'), {
        zoomControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false,
        boxZoom: false, keyboard: false, touchZoom: false, fadeAnimation: false, zoomAnimation: false
      });
      var tl = L.tileLayer(TILE_URL, TILE_OPTS).addTo(m);
      if (districts) L.geoJSON(districts.lines, { style: STYLE_DISTRICT }).addTo(m);

      // Context: the SA1s of every loaded SA2 that overlaps this SA1's surroundings.
      var target = sa1Layers[code].getBounds().pad(0.5);
      var context = [];
      sa2sInBounds(target).forEach(function (sa2) {
        if (sa2Data[sa2]) context = context.concat(sa2Data[sa2].features);
      });
      L.geoJSON({ type: 'FeatureCollection', features: context }, {
        style: function (f) { return f.properties.sa1 === code ? STYLE_SELECTED : STYLE_NEIGHBOUR; },
        onEachFeature: function (f, layer) {
          layer.bindTooltip(f.properties.sa1, {
            permanent: true, direction: 'center', interactive: false,
            className: 'sa1-label ' + (f.properties.sa1 === code ? 'selected' : 'neighbour')
          });
        }
      }).addTo(m);

      m.fitBounds(sa1Layers[code].getBounds(), { padding: [10, 10], maxZoom: 18 });
      tl.once('load', tileLayerDone);
      printMaps.push(m);
    });

    // Never hang on a slow tile server: print anyway after a generous wait.
    setTimeout(go, 6000 + 150 * codes.length);
  }

  window.addEventListener('afterprint', function () {
    printMaps.forEach(function (m) { m.remove(); });
    printMaps = [];
    el.printPages.innerHTML = '';
    document.body.classList.remove('printing');
    map.invalidateSize();
  });

  // ---------------------------------------------------------------- wiring
  el.apply.addEventListener('click', function () { setSelected(parseCodes(el.codes.value), true); });
  el.codes.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el.apply.click(); }
  });
  el.clear.addEventListener('click', function () { el.seat.value = ''; fillSuburbs(''); setSelected([], false); });
  el.seat.addEventListener('change', function () {
    fillSuburbs(el.seat.value);
    if (el.seat.value) setSelected(groups.seats[el.seat.value].slice(), true);
  });
  el.suburb.addEventListener('change', function () { if (el.suburb.value) pickSuburb(el.suburb.value); });
  el.login.addEventListener('input', function () { login = el.login.value.trim(); syncUi(); });
  el.print.addEventListener('click', doPrint);
  map.on('moveend zoomend', loadViewport);
  map.on('tooltipopen', function (e) {
    // Leaflet creates the tooltip DOM lazily; make sure it carries the right class.
    if (e.tooltip.options.className) setTooltipClass(e.tooltip, e.tooltip.options.className);
  });

  fetch(DATA + 'sa2_index.json').then(function (r) { return r.json(); }).then(function (idx) {
    sa2Index = idx;
    loadViewport();
  });
  fetch(DATA + 'districts.json').then(function (r) { return r.json(); }).then(function (d) {
    districts = d;
    L.geoJSON(d.lines, { style: STYLE_DISTRICT }).addTo(map);
    d.labels.forEach(function (lab) {
      L.tooltip({ permanent: true, direction: 'center', interactive: false, className: 'district-label' })
        .setLatLng([lab.lat, lab.lng]).setContent(lab.name).addTo(map);
    });
  });
  fetch(DATA + 'groups.json').then(function (r) { return r.json(); }).then(function (g) {
    groups = g;
    fillSeats();
  });

  var initial = readUrl();
  if (initial.length) setSelected(initial, true); else syncUi();
})();

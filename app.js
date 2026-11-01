/*
 * SA1 print map.
 *
 * State lives in the URL so a map can be shared or bookmarked:
 *   ?sa1=21203130422,21203130423&pin=-37.8,144.96,Meet%20here&pin=...
 *
 * Data is pre-split per SA2 (data/sa2/<9 digits>.json); an SA1 code's first 9 digits
 * are its SA2 code, so the file for any code is known without an index. The SA2
 * bbox index (data/sa2_index.json) is only used to load whatever is in view so the
 * surrounding SA1s can be drawn and clicked.
 */
(function () {
  'use strict';

  var DATA = 'data/';
  var NEIGHBOUR_ZOOM = 13;   // load and draw surrounding SA1s from this zoom
  var LABEL_ZOOM = 15;       // show neighbour code labels from this zoom

  var STYLE_SELECTED = { color: '#d00', weight: 3, opacity: 1, fillColor: '#d00', fillOpacity: 0.08 };
  var STYLE_NEIGHBOUR = { color: '#777', weight: 1, opacity: 0.8, fillColor: '#000', fillOpacity: 0 };

  var map = L.map('map').setView([-37.81, 144.96], 10);
  var tiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  var selected = [];              // SA1 codes in the order they were entered
  var pins = [];                  // {lat, lng, label, marker}
  var sa1Layers = {};             // code -> Leaflet polygon layer (once its SA2 file is loaded)
  var sa2Loads = {};              // SA2 code -> Promise (dedupes fetches)
  var sa2Index = null;            // SA2 code -> [minlng, minlat, maxlng, maxlat]
  var pinMode = false;

  var el = {
    codes: document.getElementById('codes'),
    apply: document.getElementById('apply'),
    addpin: document.getElementById('addpin'),
    print: document.getElementById('print'),
    status: document.getElementById('status'),
    list: document.getElementById('header-list'),
    date: document.getElementById('header-date')
  };

  // ---------------------------------------------------------------- data loading
  function loadSa2(sa2) {
    if (!sa2Loads[sa2]) {
      sa2Loads[sa2] = fetch(DATA + 'sa2/' + sa2 + '.json')
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (geojson) {
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
      if (pinMode) { placePin(e.latlng); return; }
      toggleSelected(code);
    });
  }

  function applyLayerStyle(code) {
    var layer = sa1Layers[code];
    if (!layer) return;
    var isSel = selected.indexOf(code) >= 0;
    layer.setStyle(isSel ? STYLE_SELECTED : STYLE_NEIGHBOUR);
    if (isSel) layer.bringToFront();
    var tip = layer.getTooltip();
    if (tip) {
      var tipEl = tip.getElement();
      // Tooltip element may not exist yet if the layer is off-screen; class is also set on open.
      tip.options.className = 'sa1-label ' + (isSel ? 'selected' : 'neighbour');
      if (tipEl) tipEl.className = 'leaflet-tooltip leaflet-zoom-animated ' + tip.options.className;
    }
  }

  // Load every SA2 whose bbox touches the viewport so neighbours can be seen and clicked.
  function loadViewport() {
    map.getContainer().classList.toggle('show-neighbour-labels', map.getZoom() >= LABEL_ZOOM);
    if (map.getZoom() < NEIGHBOUR_ZOOM || !sa2Index) return;
    var b = map.getBounds();
    Object.keys(sa2Index).forEach(function (sa2) {
      var x = sa2Index[sa2];
      if (x[2] >= b.getWest() && x[0] <= b.getEast() && x[3] >= b.getSouth() && x[1] <= b.getNorth()) loadSa2(sa2);
    });
  }

  // ---------------------------------------------------------------- selection
  function parseCodes(text) {
    var found = text.match(/\d{11}/g) || [];
    var out = [];
    found.forEach(function (c) { if (out.indexOf(c) < 0) out.push(c); });
    return out;
  }

  function setSelected(codes, zoomTo) {
    var previous = selected.slice();
    selected = codes;
    previous.forEach(applyLayerStyle);
    var sa2s = {};
    codes.forEach(function (c) { sa2s[c.slice(0, 9)] = true; });
    return Promise.all(Object.keys(sa2s).map(loadSa2)).then(function () {
      selected.forEach(applyLayerStyle);
      var missing = selected.filter(function (c) { return !sa1Layers[c]; });
      el.status.textContent = missing.length ? 'Not found in Victoria: ' + missing.join(', ') : '';
      syncUi();
      if (zoomTo) fitSelected();
    });
  }

  function toggleSelected(code) {
    var i = selected.indexOf(code);
    if (i >= 0) selected.splice(i, 1); else selected.push(code);
    applyLayerStyle(code);
    el.status.textContent = '';
    syncUi();
  }

  function selectedBounds() {
    var group = L.featureGroup(selected.map(function (c) { return sa1Layers[c]; }).filter(Boolean));
    return group.getLayers().length ? group.getBounds() : null;
  }

  function fitSelected() {
    var b = selectedBounds();
    if (b) map.fitBounds(b, { padding: [30, 30], maxZoom: 18 });
  }

  // ---------------------------------------------------------------- pins
  function placePin(latlng) {
    var label = window.prompt('Pin label (leave blank for none)', '');
    setPinMode(false);
    if (label === null) return;
    addPin({ lat: latlng.lat, lng: latlng.lng, label: label.trim() });
    syncUi();
  }

  function addPin(p) {
    var marker = L.marker([p.lat, p.lng], { draggable: true }).addTo(map);
    if (p.label) marker.bindTooltip(p.label, { permanent: true, direction: 'top', offset: [-15, -10], className: 'pin-label' });
    marker.on('dragend', function () {
      var ll = marker.getLatLng();
      p.lat = ll.lat; p.lng = ll.lng;
      syncUi();
    });
    marker.on('click', function (e) {
      L.DomEvent.stopPropagation(e);
      if (!window.confirm('Remove this pin' + (p.label ? ' (' + p.label + ')' : '') + '?')) return;
      map.removeLayer(marker);
      pins.splice(pins.indexOf(p), 1);
      syncUi();
    });
    p.marker = marker;
    pins.push(p);
  }

  function setPinMode(on) {
    pinMode = on;
    document.body.classList.toggle('pinmode', on);
    el.addpin.classList.toggle('armed', on);
    el.addpin.textContent = on ? 'Click the map…' : 'Add pin';
  }

  // ---------------------------------------------------------------- URL, header, textarea
  function syncUi() {
    // Built by hand rather than URLSearchParams so the commas stay readable in the address bar.
    var parts = [];
    if (selected.length) parts.push('sa1=' + selected.join(','));
    pins.forEach(function (p) {
      parts.push('pin=' + p.lat.toFixed(6) + ',' + p.lng.toFixed(6) + (p.label ? ',' + encodeURIComponent(p.label) : ''));
    });
    history.replaceState(null, '', parts.length ? '?' + parts.join('&') : location.pathname);

    if (document.activeElement !== el.codes) el.codes.value = selected.join('\n');

    el.list.innerHTML = '';
    selected.forEach(function (c) {
      var props = sa1Layers[c] ? sa1Layers[c].feature.properties : null;
      var li = document.createElement('li');
      var b = document.createElement('b');
      b.textContent = c;
      li.appendChild(b);
      li.appendChild(document.createTextNode(props ? '  ' + props.suburb + '  (' + props.district + ')' : '  not found'));
      el.list.appendChild(li);
    });
    el.date.textContent = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  function readUrl() {
    var params = new URLSearchParams(location.search);
    params.getAll('pin').forEach(function (s) {
      var parts = s.split(',');
      var lat = parseFloat(parts[0]), lng = parseFloat(parts[1]);
      if (isFinite(lat) && isFinite(lng)) addPin({ lat: lat, lng: lng, label: parts.slice(2).join(',') });
    });
    return parseCodes(params.get('sa1') || '');
  }

  // ---------------------------------------------------------------- print
  function doPrint() {
    document.body.classList.add('printing');
    map.invalidateSize();
    fitSelected();
    var done = false;
    function go() {
      if (done) return;
      done = true;
      tiles.off('load', go);
      window.print();
    }
    // Wait for the tiles of the print-sized map to arrive, but never hang on a slow tile server.
    tiles.on('load', go);
    setTimeout(go, 4000);
  }
  window.addEventListener('afterprint', function () {
    document.body.classList.remove('printing');
    map.invalidateSize();
    fitSelected();
  });

  // ---------------------------------------------------------------- wiring
  el.apply.addEventListener('click', function () { setSelected(parseCodes(el.codes.value), true); });
  el.codes.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el.apply.click(); }
  });
  el.addpin.addEventListener('click', function () { setPinMode(!pinMode); });
  el.print.addEventListener('click', doPrint);
  map.on('click', function (e) { if (pinMode) placePin(e.latlng); });
  map.on('moveend zoomend', loadViewport);
  map.on('tooltipopen', function (e) {
    // Leaflet creates the tooltip DOM lazily; make sure it carries the right class.
    var el2 = e.tooltip.getElement();
    if (el2 && e.tooltip.options.className.indexOf('sa1-label') === 0) el2.className = 'leaflet-tooltip leaflet-zoom-animated ' + e.tooltip.options.className;
  });

  fetch(DATA + 'sa2_index.json').then(function (r) { return r.json(); }).then(function (idx) {
    sa2Index = idx;
    loadViewport();
  });

  var initial = readUrl();
  if (initial.length) setSelected(initial, true); else syncUi();
})();

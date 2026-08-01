import { searchPlaces, reverseGeocode } from "./geocode.js";
import {
  angularCircle,
  clampDurationParts,
  computeCentreOfMass,
  formatDuration,
  formatPlaceDuration,
  formatPlacesTotal,
  formatSpread,
  normalizePlace,
  validatePlaceDuration,
  WHEEL_MAX,
} from "./com.js";

const STORAGE_KEY = "com-places-v4";
const LEGACY_STORAGE_KEY = "com-places-v3";
const MODE_KEY = "com-mode-v1";
const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const MAX_ZOOM = 10;

/** @typedef {{ id: string, name: string, lat: number, lng: number, years: number, months: number, days: number }} Place */
/** @typedef {{ name: string, lat: number, lng: number, label: string }} GeoHit */

/** @type {Place[]} */
let places = [];
/** @type {"edit" | "view"} */
let mode = "edit";
/** @type {string | null} */
let selectedId = null;
/** @type {"add" | "edit"} */
let modalMode = "add";
/** @type {{ lat: number, lng: number } | null} */
let pendingClick = null;
/** @type {GeoHit | null} */
let selectedSearch = null;
/** @type {GeoHit | null} */
let moveSearch = null;
/** @type {{ lat: number, lng: number, totalMonths: number } | null} */
let centreOfMass = null;
/** @type {{ name: string, label: string } | null} */
let comSettlement = null;
let comLookupToken = 0;
let mapReady = false;
/** @type {maplibregl.Marker | null} */
let comMarker = null;

const $ = (id) => document.getElementById(id);
const els = {
  stage: $("stage"),
  badge: $("stage-badge"),
  body: $("places-body"),
  form: $("add-form"),
  query: $("place-query"),
  durationWheels: $("duration-wheels"),
  suggestions: $("suggestions"),
  status: $("form-status"),
  btnDone: $("btn-done"),
  btnAddMore: $("btn-add-more"),
  btnExport: $("btn-export"),
  btnClear: $("btn-clear"),
  btnLink: $("btn-link"),
  modal: $("click-modal"),
  modalTitle: $("modal-title"),
  clickForm: $("click-form"),
  clickName: $("click-name"),
  clickDurationWheels: $("click-duration-wheels"),
  clickCoords: $("click-coords"),
  clickCancel: $("click-cancel"),
  clickDelete: $("click-delete"),
  clickSubmit: $("click-submit"),
  moveField: $("move-field"),
  clickMove: $("click-move"),
  moveSuggestions: $("move-suggestions"),
  comCard: $("com-card"),
  comSettlement: $("com-settlement"),
  comCoords: $("com-coords"),
  comSpread: $("com-spread"),
  comMeta: $("com-meta"),
  placesTotal: $("places-total"),
  placesTotalValue: $("places-total-value"),
};

function uid() {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function escapeAttr(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
}

function setStatus(message, isError = false) {
  els.status.textContent = message || "";
  els.status.classList.toggle("error", isError);
}

function getSelected() {
  return places.find((p) => p.id === selectedId) || null;
}

function updateRevealButton() {
  els.btnDone.disabled = places.length === 0;
}

/* ---------- Duration wheels ---------- */
function fillWheelOptions(select, max) {
  select.innerHTML = "";
  for (let i = 0; i <= max; i++) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = String(i);
    select.appendChild(opt);
  }
}

function createDurationWheels(container, idPrefix) {
  container.innerHTML = "";
  /** @type {Record<"years"|"months"|"days", HTMLSelectElement>} */
  const selects = {};

  for (const [part, label] of [
    ["years", "years"],
    ["months", "months"],
    ["days", "days"],
  ]) {
    const col = document.createElement("div");
    col.className = "wheel-col";

    const select = document.createElement("select");
    select.className = "duration-wheel";
    select.id = `${idPrefix}-${part}`;
    select.size = 4;
    select.setAttribute("aria-label", label);
    fillWheelOptions(select, WHEEL_MAX[part]);
    select.value = "0";

    const caption = document.createElement("span");
    caption.textContent = label;

    col.append(select, caption);
    container.appendChild(col);
    selects[part] = select;
  }

  return {
    get() {
      return clampDurationParts({
        years: selects.years.value,
        months: selects.months.value,
        days: selects.days.value,
      });
    },
    set(parts) {
      const next = clampDurationParts(parts);
      selects.years.value = String(next.years);
      selects.months.value = String(next.months);
      selects.days.value = String(next.days);
      for (const sel of Object.values(selects)) {
        const opt = sel.selectedOptions[0];
        if (!opt) continue;
        // scrollIntoView also scrolls parent frames when this app is embedded.
        sel.scrollTop = opt.offsetTop - (sel.clientHeight - opt.offsetHeight) / 2;
      }
    },
    reset() {
      this.set({ years: 0, months: 0, days: 0 });
    },
    setDisabled(disabled) {
      for (const sel of Object.values(selects)) sel.disabled = disabled;
    },
  };
}

const formWheels = createDurationWheels(els.durationWheels, "duration");
const modalWheels = createDurationWheels(els.clickDurationWheels, "click-duration");

/* ---------- Autocomplete ---------- */
function createAutocomplete(input, listEl, onPick) {
  let timer = null;
  let items = [];
  let active = -1;

  function hide() {
    listEl.classList.remove("open");
    listEl.innerHTML = "";
    active = -1;
    items = [];
  }

  function show(results) {
    items = results;
    active = results.length ? 0 : -1;
    listEl.innerHTML = "";
    if (!results.length) {
      hide();
      return;
    }
    results.forEach((item, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "suggestion" + (i === 0 ? " active" : "");
      btn.textContent = item.label;
      btn.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        onPick(item);
        hide();
      });
      listEl.appendChild(btn);
    });
    listEl.classList.add("open");
  }

  input.addEventListener("input", () => {
    const q = input.value.trim();
    clearTimeout(timer);
    if (q.length < 2) {
      hide();
      return;
    }
    timer = setTimeout(async () => {
      try {
        show(await searchPlaces(q, { count: 6 }));
      } catch (err) {
        setStatus(err.message || "Search failed", true);
      }
    }, 280);
  });

  input.addEventListener("keydown", (e) => {
    if (!listEl.classList.contains("open")) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      active = Math.min(active + 1, items.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active = Math.max(active - 1, 0);
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      onPick(items[active]);
      hide();
      return;
    } else if (e.key === "Escape") {
      hide();
      return;
    } else {
      return;
    }
    [...listEl.children].forEach((el, i) => {
      el.classList.toggle("active", i === active);
    });
  });

  document.addEventListener("click", (e) => {
    if (!listEl.contains(e.target) && e.target !== input) hide();
  });

  return { hide };
}

const searchAc = createAutocomplete(els.query, els.suggestions, (item) => {
  selectedSearch = item;
  els.query.value = item.label;
  setStatus(`Selected ${item.label}`);
});

const moveAc = createAutocomplete(els.clickMove, els.moveSuggestions, (item) => {
  moveSearch = item;
  els.clickMove.value = item.label;
  els.clickName.value = item.name;
  els.clickCoords.textContent = `${item.label} (${item.lat.toFixed(3)}, ${item.lng.toFixed(3)})`;
});

els.query.addEventListener("input", () => {
  selectedSearch = null;
});
els.clickMove.addEventListener("input", () => {
  moveSearch = null;
});

/* ---------- Table / places ---------- */
function renderPlacesTotal() {
  const hasPlaces = places.length > 0;
  els.placesTotal.hidden = !hasPlaces;
  els.placesTotalValue.textContent = hasPlaces ? formatPlacesTotal(places) : "–";
}

function renderTable() {
  els.body.innerHTML = "";
  if (!places.length) {
    els.body.innerHTML =
      `<tr><td colspan="3" style="color: var(--muted)">No places yet – search above or click the map.</td></tr>`;
    renderPlacesTotal();
    return;
  }

  for (const place of places) {
    const tr = document.createElement("tr");
    tr.dataset.id = place.id;
    tr.className = "selectable" + (place.id === selectedId ? " selected" : "");
    tr.innerHTML = `
      <td class="place-name-cell">
        <button type="button" class="place-select" data-action="select">${escapeAttr(place.name)}</button>
      </td>
      <td class="duration-cell">
        <button type="button" class="place-select" data-action="edit">${escapeAttr(formatPlaceDuration(place))}</button>
      </td>
      <td class="actions-cell">
        <button type="button" class="btn-icon-remove" data-action="delete" title="Remove ${escapeAttr(place.name)}" aria-label="Remove ${escapeAttr(place.name)}">×</button>
      </td>
    `;
    els.body.appendChild(tr);
  }
  renderPlacesTotal();
}

function flyToPlace(place, minZoom = 5) {
  if (!mapReady || !place) return;
  map.flyTo({
    center: [place.lng, place.lat],
    zoom: Math.max(map.getZoom(), minZoom),
    essential: true,
  });
}

function selectPlace(id, { openEditor = false } = {}) {
  selectedId = id;
  renderTable();
  upsertMapMarkers();
  const place = getSelected();
  flyToPlace(place, mode === "view" ? 3.2 : 5);
  if (openEditor && place && mode === "edit") openEditModal(place);
}

function addPlace(partial) {
  const parts = clampDurationParts(partial);
  const place = {
    id: uid(),
    name: String(partial.name).trim(),
    lat: Number(partial.lat),
    lng: Number(partial.lng),
    ...parts,
  };
  if (!place.name || Number.isNaN(place.lat) || Number.isNaN(place.lng)) {
    setStatus("Need a valid place with coordinates.", true);
    return false;
  }
  const err = validatePlaceDuration(place);
  if (err) {
    setStatus(err, true);
    return false;
  }
  places.push(place);
  selectedSearch = null;
  selectedId = place.id;
  refreshViews();
  setStatus(`Added ${place.name} (${formatPlaceDuration(place)}).`);
  flyToPlace(place);
  return true;
}

function updatePlace(id, partial) {
  const place = places.find((p) => p.id === id);
  if (!place) return false;
  const next = {
    ...place,
    name:
      partial.name != null
        ? String(partial.name).trim() || place.name
        : place.name,
    ...clampDurationParts({
      years: partial.years ?? place.years,
      months: partial.months ?? place.months,
      days: partial.days ?? place.days,
    }),
    lat: partial.lat != null ? Number(partial.lat) : place.lat,
    lng: partial.lng != null ? Number(partial.lng) : place.lng,
  };
  const err = validatePlaceDuration(next);
  if (err) {
    setStatus(err, true);
    return false;
  }
  Object.assign(place, next);
  refreshViews();
  setStatus(`Updated ${place.name}.`);
  return true;
}

function removePlace(id) {
  const removed = places.find((p) => p.id === id);
  places = places.filter((p) => p.id !== id);
  if (selectedId === id) selectedId = null;
  refreshViews();
  if (removed) setStatus(`Removed ${removed.name}.`);
}

/* ---------- Centre of mass UI ---------- */
function removeComAnnotation() {
  comMarker?.remove();
  comMarker = null;
}

function upsertComAnnotation() {
  removeComAnnotation();
  if (!mapReady || mode !== "view" || !centreOfMass) return;

  const settlement =
    comSettlement?.label ||
    comSettlement?.name ||
    "Finding nearest settlement…";
  const coords = `${centreOfMass.lat.toFixed(3)}°, ${centreOfMass.lng.toFixed(3)}°`;
  const spread = `Spread ${formatSpread(centreOfMass.rmsSpreadDeg)} RMS`;

  const el = document.createElement("div");
  el.className = "com-annotation";
  el.innerHTML = `
    <div class="com-annotation-label">
      <p class="com-annotation-kicker">Centre of mass</p>
      <p class="com-annotation-place">${escapeAttr(settlement)}</p>
      <p class="com-annotation-coords">${escapeAttr(coords)}</p>
      <p class="com-annotation-spread">${escapeAttr(spread)}</p>
    </div>
  `;

  comMarker = new maplibregl.Marker({
    element: el,
    anchor: "bottom",
    offset: [0, -12],
  })
    .setLngLat([centreOfMass.lng, centreOfMass.lat])
    .addTo(map);
}

function spreadRingFeature() {
  if (mode !== "view" || !centreOfMass || !(centreOfMass.rmsSpreadRad > 1e-4)) {
    return { type: "FeatureCollection", features: [] };
  }
  const ring = angularCircle(
    centreOfMass.lat,
    centreOfMass.lng,
    centreOfMass.rmsSpreadRad
  );
  if (ring.length < 4) return { type: "FeatureCollection", features: [] };
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [ring] },
      },
    ],
  };
}

function upsertMapMarkers() {
  if (!mapReady) return;

  map.getSource("places")?.setData({
    type: "FeatureCollection",
    features: places.map((p) => ({
      type: "Feature",
      properties: {
        id: p.id,
        name: p.name,
        selected: p.id === selectedId ? 1 : 0,
      },
      geometry: { type: "Point", coordinates: [p.lng, p.lat] },
    })),
  });

  const showCom = mode === "view" && centreOfMass;
  map.getSource("com")?.setData({
    type: "FeatureCollection",
    features: showCom
      ? [
          {
            type: "Feature",
            properties: {},
            geometry: {
              type: "Point",
              coordinates: [centreOfMass.lng, centreOfMass.lat],
            },
          },
        ]
      : [],
  });
  map.getSource("com-spread")?.setData(spreadRingFeature());

  upsertComAnnotation();
}

function renderComCard() {
  if (mode !== "view" || !centreOfMass) {
    els.comCard.hidden = true;
    return;
  }
  els.comCard.hidden = false;
  els.comCoords.textContent = `${centreOfMass.lat.toFixed(3)}°, ${centreOfMass.lng.toFixed(3)}°`;
  els.comSpread.textContent = `Time-weighted spread: ${formatSpread(
    centreOfMass.rmsSpreadDeg
  )} RMS`;
  els.comMeta.textContent = `Weighted by ${formatDuration(
    centreOfMass.totalMonths
  )} across ${places.length} entr${places.length === 1 ? "y" : "ies"}`;
  els.comSettlement.textContent = comSettlement
    ? comSettlement.label || comSettlement.name
    : "Finding nearest settlement…";
}

async function updateCentreOfMass() {
  centreOfMass = computeCentreOfMass(places);
  comSettlement = null;
  renderComCard();
  upsertMapMarkers();
  if (!centreOfMass) return;

  const token = ++comLookupToken;
  try {
    const rev = await reverseGeocode(centreOfMass.lat, centreOfMass.lng);
    if (token !== comLookupToken) return;
    comSettlement = { name: rev.name, label: rev.label };
  } catch {
    if (token !== comLookupToken) return;
    comSettlement = { name: "Unknown", label: "Nearest settlement unavailable" };
  }
  renderComCard();
  upsertComAnnotation();
}

function refreshViews() {
  renderTable();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(places));
  updateRevealButton();
  updateCentreOfMass();
}

/* ---------- Mode / projection ---------- */
function applyProjection() {
  if (!mapReady) return;
  if (mode === "view") {
    map.setProjection({ type: "globe" });
    map.setSky?.({
      "sky-color": "#87CEEB",
      "sky-horizon-blend": 0.6,
      "horizon-color": "#ffffff",
      "horizon-fog-blend": 0.4,
      "fog-color": "#ffffff",
      "fog-ground-blend": 0.3,
    });
  } else {
    map.setProjection({ type: "mercator" });
    map.setSky?.(undefined);
  }
}

function setMode(next) {
  mode = next;
  localStorage.setItem(MODE_KEY, mode);
  const isView = mode === "view";

  els.stage.classList.toggle("view-mode", isView);
  els.stage.classList.toggle("edit-mode", !isView);
  els.btnDone.hidden = isView;
  els.btnAddMore.hidden = !isView;
  els.badge.hidden = isView;
  updateRevealButton();

  els.form.querySelectorAll("input, button[type=submit]").forEach((el) => {
    el.disabled = isView;
  });
  formWheels.setDisabled(isView);

  applyProjection();
  upsertMapMarkers();
  renderComCard();
  if (!mapReady) return;

  if (isView) {
    closeModal();
    searchAc.hide();
    moveAc.hide();
    const focus = centreOfMass || getSelected() || places.at(-1);
    map.easeTo({
      center: focus ? [focus.lng, focus.lat] : [0, 20],
      zoom: focus ? 2.4 : 1.6,
      pitch: 0,
      bearing: 0,
      duration: 1100,
      essential: true,
    });
  } else {
    map.easeTo({
      pitch: 0,
      zoom: Math.max(map.getZoom(), 1.8),
      duration: 700,
    });
  }
}

/* ---------- MapLibre ---------- */
const map = new maplibregl.Map({
  container: "map",
  style: MAP_STYLE,
  center: [0, 20],
  zoom: 1.6,
  maxZoom: MAX_ZOOM,
  projection: { type: "mercator" },
  attributionControl: false,
});

map.addControl(
  new maplibregl.AttributionControl({ compact: true}),
  "bottom-right"
)

map.addControl(
  new maplibregl.NavigationControl({ visualizePitch: false }),
  "top-right"
);

const mapEl = document.getElementById("map");
if (mapEl && typeof ResizeObserver !== "undefined") {
  new ResizeObserver(() => {
    map.resize();
  }).observe(mapEl);
}

map.on("load", () => {
  mapReady = true;
  map.addSource("places", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addSource("com", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addSource("com-spread", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addLayer({
    id: "com-spread-fill",
    type: "fill",
    source: "com-spread",
    paint: {
      "fill-color": "#f5c542",
      "fill-opacity": 0.16,
    },
  });
  map.addLayer({
    id: "com-spread-line",
    type: "line",
    source: "com-spread",
    paint: {
      "line-color": "#f5c542",
      "line-width": 2,
      "line-opacity": 0.9,
    },
  });
  map.addLayer({
    id: "places-circle",
    type: "circle",
    source: "places",
    paint: {
      "circle-radius": ["case", ["==", ["get", "selected"], 1], 9, 6],
      "circle-color": [
        "case",
        ["==", ["get", "selected"], 1],
        "#1f6f8b",
        "#e85d4c",
      ],
      "circle-stroke-width": 2,
      "circle-stroke-color": "#ffffff",
    },
  });
  map.addLayer({
    id: "com-circle",
    type: "circle",
    source: "com",
    paint: {
      "circle-radius": 8,
      "circle-color": "#f5c542",
      "circle-stroke-width": 2,
      "circle-stroke-color": "#ffffff",
    },
  });
  upsertMapMarkers();
  applyProjection();
});

map.on("mouseenter", "places-circle", () => {
  map.getCanvas().style.cursor = "pointer";
});
map.on("mouseleave", "places-circle", () => {
  map.getCanvas().style.cursor = mode === "edit" ? "crosshair" : "";
});

map.on("click", (e) => {
  if (mode !== "edit") return;
  const hits = map.queryRenderedFeatures(e.point, {
    layers: ["places-circle"],
  });
  if (hits.length) {
    selectPlace(hits[0].properties.id, { openEditor: true });
    return;
  }
  openAddModal(e.lngLat.lat, e.lngLat.lng);
});

/* ---------- Modals ---------- */
function closeModal() {
  els.modal.classList.remove("open");
  pendingClick = null;
  moveSearch = null;
  moveAc.hide();
}

function openAddModal(lat, lng) {
  modalMode = "add";
  pendingClick = { lat, lng };
  moveSearch = null;
  els.modalTitle.textContent = "Add this place";
  els.clickSubmit.textContent = "Add place";
  els.clickDelete.hidden = true;
  els.moveField.hidden = true;
  els.clickMove.value = "";
  moveAc.hide();
  modalWheels.reset();
  els.clickName.value = "";
  els.clickCoords.textContent = `Resolving ${lat.toFixed(3)}, ${lng.toFixed(3)}…`;
  els.modal.classList.add("open");

  reverseGeocode(lat, lng)
    .then((rev) => {
      if (modalMode !== "add" || !pendingClick) return;
      els.clickName.value = rev.name;
      els.clickCoords.textContent = `${rev.label} (${lat.toFixed(3)}, ${lng.toFixed(3)})`;
    })
    .catch(() => {
      if (modalMode !== "add") return;
      els.clickName.value = "Dropped pin";
      els.clickCoords.textContent = `${lat.toFixed(3)}, ${lng.toFixed(3)}`;
    });
  els.clickName.focus();
}

function openEditModal(place) {
  modalMode = "edit";
  pendingClick = { lat: place.lat, lng: place.lng };
  moveSearch = null;
  selectedId = place.id;
  els.modalTitle.textContent = "Edit place";
  els.clickSubmit.textContent = "Save changes";
  els.clickDelete.hidden = false;
  els.moveField.hidden = false;
  els.clickMove.value = "";
  moveAc.hide();
  els.clickName.value = place.name;
  modalWheels.set(place);
  els.clickCoords.textContent = `${place.name} (${place.lat.toFixed(3)}, ${place.lng.toFixed(3)})`;
  els.modal.classList.add("open");
  renderTable();
  upsertMapMarkers();
  els.clickName.focus();
}

els.clickCancel.addEventListener("click", closeModal);
els.modal.addEventListener("click", (e) => {
  if (e.target === els.modal) closeModal();
});
els.clickDelete.addEventListener("click", () => {
  if (modalMode !== "edit" || !selectedId) return;
  removePlace(selectedId);
  closeModal();
});

els.clickForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const duration = modalWheels.get();

  if (modalMode === "add") {
    if (!pendingClick) return;
    if (
      addPlace({
        name: els.clickName.value,
        lat: pendingClick.lat,
        lng: pendingClick.lng,
        ...duration,
      })
    ) {
      closeModal();
    }
    return;
  }

  if (!selectedId) return;
  let lat;
  let lng;
  if (moveSearch) {
    ({ lat, lng } = moveSearch);
  } else if (els.clickMove.value.trim()) {
    try {
      const results = await searchPlaces(els.clickMove.value, { count: 1 });
      if (!results.length) {
        setStatus("Could not find that new location.", true);
        return;
      }
      lat = results[0].lat;
      lng = results[0].lng;
      if (!els.clickName.value.trim()) els.clickName.value = results[0].name;
    } catch (err) {
      setStatus(err.message || "Move lookup failed", true);
      return;
    }
  } else {
    const place = getSelected();
    lat = place?.lat;
    lng = place?.lng;
  }

  if (
    updatePlace(selectedId, {
      name: els.clickName.value,
      ...duration,
      lat,
      lng,
    })
  ) {
    closeModal();
  }
});

/* ---------- Form / table events ---------- */
els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (mode !== "edit") return;

  try {
    let pick = selectedSearch;
    if (!pick) {
      setStatus("Looking up place…");
      const results = await searchPlaces(els.query.value, { count: 1 });
      if (!results.length) {
        setStatus("No matches for that name.", true);
        return;
      }
      pick = results[0];
    }
    if (
      addPlace({
        name: pick.name,
        lat: pick.lat,
        lng: pick.lng,
        ...formWheels.get(),
      })
    ) {
      els.query.value = "";
      selectedSearch = null;
      formWheels.reset();
      els.query.focus();
    }
  } catch (err) {
    setStatus(err.message || "Could not geocode", true);
  }
});

els.body.addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-id]");
  if (!tr) return;
  const id = tr.dataset.id;
  if (e.target.closest("[data-action=delete]")) {
    e.stopPropagation();
    removePlace(id);
    return;
  }
  if (e.target.closest("[data-action=edit]")) {
    const place = places.find((p) => p.id === id);
    if (place && mode === "edit") openEditModal(place);
    return;
  }
  if (e.target.closest("[data-action=select]")) {
    selectPlace(id);
    return;
  }
  if (!e.target.closest("button")) {
    selectPlace(id);
  }
});

els.btnDone.addEventListener("click", () => setMode("view"));
els.btnAddMore.addEventListener("click", () => setMode("edit"));

els.btnLink.addEventListener("click", () => {
  window.open("https://github.com/orlando-code/centre-of-mass", "_blank");
});

els.btnExport.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(places, null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "places.json";
  a.click();
  URL.revokeObjectURL(a.href);
});

els.btnClear.addEventListener("click", () => {
  if (!places.length) {
    setStatus("Nothing to clear.");
    return;
  }
  if (!confirm("Remove all places?")) return;
  places = [];
  selectedId = null;
  centreOfMass = null;
  comSettlement = null;
  removeComAnnotation();
  refreshViews();
  setStatus("Cleared all points.");
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && els.modal.classList.contains("open")) closeModal();
});

/* ---------- Boot ---------- */
function loadSaved() {
  try {
    let raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    const parsed = JSON.parse(raw || "[]");
    places = Array.isArray(parsed)
      ? parsed.map(normalizePlace).filter(Boolean)
      : [];
    if (places.length) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(places));
    }
  } catch {
    places = [];
  }
}

formWheels.reset();
modalWheels.reset();
loadSaved();
refreshViews();
setMode(localStorage.getItem(MODE_KEY) === "view" ? "view" : "edit");

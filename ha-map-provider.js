// ha-map-provider: replaces the base map tiles of Home Assistant's built-in
// <ha-map> (map panel, more-info dialog, map card, zone editor).
//
// Works with three generations of the HA frontend:
// - up to 2026.8: Leaflet with a raster CARTO layer, swapped in place;
// - 2026.9: Leaflet with a MapLibre vector layer and a raster fallback through
//   core's tile proxy. The vector style is refused, so HA falls back to raster;
// - 2026.10 and later: a MapLibre engine with a Leaflet raster fallback engine.
//   Maps are sent to the Leaflet engine, except the zone editor: only MapLibre
//   can edit there, so it keeps HA's own map.
//
// Usage: /local/ha-map-provider.js?provider=2gis

const PROVIDERS = {
  "2gis": {
    url: "https://tile{s}.maps.2gis.com/tiles?x={x}&y={y}&z={z}&v=1",
    subdomains: "0123",
    maxNativeZoom: 18,
    attribution: '&copy; <a href="https://2gis.ru">2ГИС</a>',
  },
  yandex: {
    url: "https://core-renderer-tiles.maps.yandex.net/tiles?l=map&x={x}&y={y}&z={z}&scale=1&lang=ru_RU",
    maxNativeZoom: 19,
    attribution: '&copy; <a href="https://yandex.ru/maps">Яндекс</a>',
    // Drawn in EPSG:3395 (ellipsoidal Mercator), the map is EPSG:3857.
    ellipsoidal: true,
  },
  osm: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    maxNativeZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  },
};

// HA's own raster layers: CARTO up to 2026.8, core's proxy from 2026.9, OSM in
// the demo.
const BUILTIN_TILES = [
  "basemaps.cartocdn.com",
  "/api/map_tiles/raster/",
  "tile.openstreetmap.org",
];

// 2026.9 loads its vector base map from these; refusing them makes it fall
// back to the raster layer.
const VECTOR_STYLE_PATH = /^\/static\/map\/(light|dark)\.json$/;

// WGS84 eccentricity, for EPSG:3395.
const EARTH_E = 0.0818191908426;

// Global: HACS also registers the file as a dashboard resource, so a second
// module instance (other URL, no ?provider) may load next to extra_module_url.
const PATCHED = Symbol.for("ha-map-provider");

// 1.0.x and 1.1.0 marked the prototype and the map with PATCHED itself; own
// keys let this version hook in next to a stale copy of them.
const PROTO_PATCHED = Symbol.for("ha-map-provider/proto");
const MAP_WATCHED = Symbol.for("ha-map-provider/map");

// Shared by the instances. An explicit ?provider wins over the default, in
// whichever order they load: the mobile app may run the dashboard resource
// first and draw maps before extra_module_url arrives.
const shared = (globalThis[PATCHED] ??= {});
shared.maps ??= new Set();
const requested = new URL(import.meta.url).searchParams.get("provider");
let switched = false;
if (requested && !PROVIDERS[requested]) {
  console.error(
    `ha-map-provider: unknown provider "${requested}", known: ${Object.keys(PROVIDERS).join(", ")}`
  );
} else if (requested || !shared.name) {
  switched = Boolean(shared.name) && shared.name !== (requested || "2gis");
  shared.name = requested || "2gis";
}

const fillUrl = (template, x, y, z) =>
  template.replace(/\{([xyz])\}/g, (_, key) => ({ x, y, z })[key]);

// EPSG:3395 pixel row of the Web Mercator pixel row `y` in a world `size` px
// high. Both are Mercator, so within one tile the difference is a shift with a
// stretch below one pixel.
const ellipsoidalRow = (y, size) => {
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / size)));
  const sin = Math.sin(lat);
  const mercY =
    Math.log(Math.tan(Math.PI / 4 + lat / 2)) -
    (EARTH_E / 2) * Math.log((1 + EARTH_E * sin) / (1 - EARTH_E * sin));
  return size * (0.5 - mercY / (2 * Math.PI));
};

// Replaces TileLayer#createTile: one Web Mercator tile cut from the one or two
// EPSG:3395 tiles it overlaps, shifted by the offset at its center. Plain
// <img>, so the tile server needs no CORS.
function createEllipsoidalTile(coords, done) {
  const tile = document.createElement("div");
  tile.style.overflow = "hidden";
  const size = this.getTileSize();
  const rows = 2 ** coords.z;
  const center = (coords.y + 0.5) * size.y;
  const top = Math.round(ellipsoidalRow(center, rows * size.y) - size.y / 2);
  const first = Math.floor(top / size.y);
  const offset = top - first * size.y;
  const sources = (offset ? [first, first + 1] : [first]).filter(
    (row) => row >= 0 && row < rows
  );

  let pending = sources.length;
  let loaded = 0;
  const settle = (ok) => {
    loaded += ok ? 1 : 0;
    if (--pending === 0) {
      done(loaded ? undefined : new Error("ha-map-provider: no tile"), tile);
    }
  };
  if (!pending) {
    // Leaflet ignores a tile reported ready before createTile returns.
    setTimeout(() => done(undefined, tile));
  }
  sources.forEach((row) => {
    const img = document.createElement("img");
    img.alt = "";
    img.setAttribute("role", "presentation");
    Object.assign(img.style, {
      position: "absolute",
      left: "0",
      top: `${(row - first) * size.y - offset}px`,
      width: `${size.x}px`,
      height: `${size.y}px`,
    });
    img.onload = () => settle(true);
    img.onerror = () => settle(false);
    img.src = fillUrl(this._url, coords.x, row, coords.z);
    tile.append(img);
  });
  return tile;
}

// The layer is marked with the provider it shows, so a provider that arrives
// later switches it again.
const patchLayer = (leafletMap, layer) => {
  if (
    layer[PATCHED] === shared.name ||
    typeof layer._url !== "string" ||
    (!layer[PATCHED] && !BUILTIN_TILES.some((mark) => layer._url.includes(mark)))
  ) {
    return;
  }
  layer[PATCHED] = shared.name;
  const provider = PROVIDERS[shared.name];
  leafletMap.attributionControl?.removeAttribution(layer.options.attribution);
  layer.options.subdomains = provider.subdomains ?? "abc";
  // Above it Leaflet scales the last level up instead of asking for tiles.
  layer.options.maxNativeZoom = provider.maxNativeZoom;
  layer.options.attribution = provider.attribution;
  if (provider.ellipsoidal) {
    layer.createTile = createEllipsoidalTile;
  } else {
    delete layer.createTile;
  }
  leafletMap.attributionControl?.addAttribution(provider.attribution);
  layer.setUrl(provider.url);
};

const watchMap = (leafletMap) => {
  if (leafletMap[MAP_WATCHED]) {
    return;
  }
  leafletMap[MAP_WATCHED] = true;
  shared.maps.add(leafletMap);
  leafletMap.on("unload", () => shared.maps.delete(leafletMap));
  leafletMap.eachLayer((layer) => patchLayer(leafletMap, layer));
  // A base layer may come later, e.g. 2026.9's raster fallback.
  leafletMap.on("layeradd", (ev) => patchLayer(leafletMap, ev.layer));
};

const isZoneEditor = (haMap) =>
  haMap.getRootNode()?.host?.localName === "ha-locations-editor";

const refuseVectorStyles = () => {
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      location.href
    );
    if (url.origin === location.origin && VECTOR_STYLE_PATH.test(url.pathname)) {
      return Promise.reject(
        new TypeError("ha-map-provider: vector base map disabled")
      );
    }
    return origFetch.call(this, input, init);
  };
};

const patchHaMap = (proto) => {
  if (proto[PROTO_PATCHED]) {
    return;
  }
  proto[PROTO_PATCHED] = true;

  let generation;
  if (typeof proto._createEngine === "function") {
    generation = "engine";
    const origLoadMap = proto._loadMap;
    proto._loadMap = function (...args) {
      if (!isZoneEditor(this)) {
        this._forceLeaflet = true;
      }
      return origLoadMap.apply(this, args);
    };
  } else {
    // Harmless before 2026.9, which loads no vector style.
    generation = "leaflet";
    refuseVectorStyles();
  }

  const origUpdate = proto.update;
  proto.update = function (changedProps) {
    origUpdate.call(this, changedProps);
    const leafletMap = this.leafletMap ?? this._engine?.leafletMap;
    if (leafletMap) {
      watchMap(leafletMap);
      // Cheap, and catches a layer a stale copy patched to its own provider.
      leafletMap.eachLayer((layer) => patchLayer(leafletMap, layer));
    }
  };
  console.info(`ha-map-provider: base map -> ${shared.name} (${generation})`);
};

if (!shared.name) {
  // Only an unknown provider was asked for: leave HA's map alone.
} else if (customElements.get("ha-map")) {
  patchHaMap(customElements.get("ha-map").prototype);
} else {
  // Patched before it is defined: an <ha-map> already in the page is upgraded
  // during define(), and its first update must see the patch.
  const origDefine = customElements.define;
  customElements.define = function (name, constructor, options) {
    if (name === "ha-map") {
      patchHaMap(constructor.prototype);
    }
    return origDefine.call(this, name, constructor, options);
  };
}

if (switched) {
  // Maps drawn under the default before this ?provider arrived.
  shared.maps.forEach((leafletMap) =>
    leafletMap.eachLayer((layer) => patchLayer(leafletMap, layer))
  );
  console.info(`ha-map-provider: base map -> ${shared.name}`);
}

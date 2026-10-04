// ha-map-provider: replaces the base map tiles of Home Assistant's built-in
// <ha-map> (map panel, more-info dialog, map card, zone editor).
//
// Target: HA frontend with Leaflet raster tiles (up to 2026.8). Since 2026.9
// the base map is drawn by MapLibre and this module does nothing.
//
// Usage: /local/ha-map-provider.js?provider=2gis

const PROVIDERS = {
  "2gis": {
    url: "https://tile{s}.maps.2gis.com/tiles?x={x}&y={y}&z={z}&v=1",
    subdomains: "0123",
    maxZoom: 18,
    attribution: '&copy; <a href="https://2gis.ru">2ГИС</a>',
  },
  osm: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    subdomains: "abc",
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  },
};

// Built-in tile layer URL in frontend 20260304.0 (setup-leaflet-map.ts).
const BUILTIN_URL_MARK = "basemaps.cartocdn.com";
// Global symbol: HACS also registers the file as a dashboard resource, so a
// second module instance (other URL) may load next to extra_module_url.
const PATCHED = Symbol.for("ha-map-provider");

const providerName =
  new URL(import.meta.url).searchParams.get("provider") || "2gis";
const provider = PROVIDERS[providerName];

const replaceTiles = (leafletMap) => {
  leafletMap.eachLayer((layer) => {
    if (layer[PATCHED] || !layer._url?.includes(BUILTIN_URL_MARK)) {
      return;
    }
    layer[PATCHED] = true;
    leafletMap.attributionControl?.removeAttribution(layer.options.attribution);
    layer.options.subdomains = provider.subdomains;
    layer.options.maxZoom = provider.maxZoom;
    layer.options.attribution = provider.attribution;
    leafletMap.attributionControl?.addAttribution(provider.attribution);
    layer.setUrl(provider.url);
  });
};

if (!provider) {
  console.error(
    `ha-map-provider: unknown provider "${providerName}", known: ${Object.keys(PROVIDERS).join(", ")}`
  );
} else {
  customElements.whenDefined("ha-map").then(() => {
    const proto = customElements.get("ha-map").prototype;
    if (proto[PATCHED]) {
      return;
    }
    proto[PATCHED] = true;
    const origUpdate = proto.update;
    proto.update = function (changedProps) {
      origUpdate.call(this, changedProps);
      if (this.leafletMap) {
        replaceTiles(this.leafletMap);
      }
    };
    console.info(`ha-map-provider: base map -> ${providerName}`);
  });
}

import { useEffect, useRef } from "react";
import { Map as MapLibre, NavigationControl, setWorkerUrl, type GeoJSONSource, type Map as MLMap } from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import "maplibre-gl/dist/maplibre-gl.css";
import type { FeatureCollection } from "geojson";

// MapLibre 6: named exports and an explicit worker URL, as MapCanvas does.
setWorkerUrl(maplibreWorkerUrl);
import type { Municipality } from "../api/types";
import { useI18n } from "../i18n";

export interface BasemapOptions {
  /** XYZ raster tile template, e.g. https://tile.openstreetmap.org/{z}/{x}/{y}.png */
  tiles: string;
  attribution: string;
}

const SIGNAL_COLOR = {
  excess: "#2a78d6", // more water
  deficit: "#e34948", // less water
};

/**
 * Pilot municipalities on a map. Clicking an outline selects it; the selection is controlled by
 * the parent so the list and the map always agree. The map is decorative for keyboard users: the
 * button list next to it is the accessible control.
 */
export function MunicipalityMap({
  geojson,
  municipalities,
  selected,
  onSelect,
  basemap,
}: {
  geojson: FeatureCollection | null;
  municipalities: Municipality[];
  selected: number | null;
  onSelect: (code: number) => void;
  basemap: BasemapOptions;
}) {
  const { t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const select = useRef(onSelect);
  select.current = onSelect;

  useEffect(() => {
    if (!box.current || map.current) return;
    const m = new MapLibre({
      container: box.current,
      style: {
        version: 8,
        sources: {
          base: { type: "raster", tiles: [basemap.tiles], tileSize: 256, attribution: basemap.attribution },
        },
        layers: [{ id: "base", type: "raster", source: "base", paint: { "raster-saturation": -0.6, "raster-opacity": 0.85 } }],
      },
      bounds: [-58, -33.8, -34.8, 5.3], // Brazil
      fitBoundsOptions: { padding: 12 },
      attributionControl: { compact: true },
      cooperativeGestures: true,
    });
    m.addControl(new NavigationControl({ showCompass: false }), "top-right");
    m.on("load", () => {
      m.addSource("muns", { type: "geojson", data: geojson ?? { type: "FeatureCollection", features: [] } });
      m.addLayer({
        id: "muns-fill",
        type: "fill",
        source: "muns",
        paint: {
          "fill-color": ["match", ["get", "enso_signal"], "excess", SIGNAL_COLOR.excess, SIGNAL_COLOR.deficit],
          "fill-opacity": ["case", ["==", ["get", "code"], selected ?? -1], 0.55, 0.3],
        },
      });
      m.addLayer({
        id: "muns-line",
        type: "line",
        source: "muns",
        paint: { "line-color": "#0b0b0b", "line-width": ["case", ["==", ["get", "code"], selected ?? -1], 2.5, 1] },
      });
      // Municipalities are small at country zoom: a centroid dot keeps them findable.
      m.addSource("pts", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: municipalities.map((mu) => ({
            type: "Feature",
            properties: { code: mu.code, enso_signal: mu.enso_signal, name: mu.name_official },
            geometry: { type: "Point", coordinates: [mu.centroid_lon, mu.centroid_lat] },
          })),
        },
      });
      m.addLayer({
        id: "pts",
        type: "circle",
        source: "pts",
        maxzoom: 8,
        paint: {
          "circle-radius": 7,
          "circle-color": ["match", ["get", "enso_signal"], "excess", SIGNAL_COLOR.excess, SIGNAL_COLOR.deficit],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });
      for (const layer of ["muns-fill", "pts"]) {
        m.on("click", layer, (e) => {
          const code = e.features?.[0]?.properties?.code;
          if (code != null) select.current(Number(code));
        });
        m.on("mouseenter", layer, () => (m.getCanvas().style.cursor = "pointer"));
        m.on("mouseleave", layer, () => (m.getCanvas().style.cursor = ""));
      }
    });
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
    // The map is created once; data/selection updates are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m || !m.isStyleLoaded()) return;
    (m.getSource("muns") as GeoJSONSource | undefined)?.setData(geojson ?? { type: "FeatureCollection", features: [] });
  }, [geojson]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const apply = () => {
      if (!m.getLayer("muns-fill")) return;
      m.setPaintProperty("muns-fill", "fill-opacity", ["case", ["==", ["get", "code"], selected ?? -1], 0.55, 0.3]);
      m.setPaintProperty("muns-line", "line-width", ["case", ["==", ["get", "code"], selected ?? -1], 2.5, 1]);
    };
    if (m.isStyleLoaded()) apply();
    else m.once("load", apply);
  }, [selected]);

  return <div ref={box} className="fp-map" role="img" aria-label={t.map.label} />;
}

export function MunicipalityPicker({
  municipalities,
  selected,
  onSelect,
}: {
  municipalities: Municipality[];
  selected: number | null;
  onSelect: (code: number) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="fp-places" role="group" aria-label={t.sections.place}>
      {municipalities.map((m) => (
        <button key={m.code} type="button" className="fp-place" aria-pressed={m.code === selected} onClick={() => onSelect(m.code)}>
          <strong>
            {m.name_official} ({m.uf})
          </strong>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span className="fp-dot" style={{ background: SIGNAL_COLOR[m.enso_signal] }} />
            {t.signal[m.enso_signal]}
          </span>
          <br />
          <span>
            {(Array.isArray(m.hazards) ? m.hazards : String(m.hazards).split(","))
              .map((h) => t.hazards[h] ?? h)
              .join(" · ")}
          </span>
        </button>
      ))}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import mapWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { FeatureCollection } from "geojson";
import { Maximize, WifiOff } from "lucide-react";
import type { Filters, PropertyDetail } from "../shared/types";
import { api, query } from "./api";
maplibregl.setWorkerUrl(mapWorkerUrl);
const empty: FeatureCollection = { type: "FeatureCollection", features: [] };
export default function MapView({
  filters,
  version,
  selected,
  onSelect,
  onBounds,
}: {
  filters: Filters;
  version: number;
  selected: PropertyDetail | null;
  onSelect: (id: string) => void;
  onBounds: (bbox: string) => void;
}) {
  const el = useRef<HTMLDivElement>(null),
    map = useRef<maplibregl.Map | null>(null);
  const latest = useRef({ filters, onSelect, onBounds }),
    request = useRef<AbortController | null>(null);
  latest.current = { filters, onSelect, onBounds };
  const [loaded, setLoaded] = useState(false),
    [error, setError] = useState(""),
    [tileError, setTileError] = useState(false);
  const refresh = useRef(() => {});
  useEffect(() => {
    if (!el.current) return;
    let m: maplibregl.Map;
    try {
      m = new maplibregl.Map({
        container: el.current,
        center: [-111.974, 41.231],
        zoom: 10.5,
        maxZoom: 19,
        minZoom: 1,
        attributionControl: { compact: true },
        style: {
          version: 8,
          sources: {
            osm: {
              type: "raster",
              tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
              tileSize: 256,
              maxzoom: 19,
              attribution:
                '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
            },
          },
          layers: [
            {
              id: "background",
              type: "background",
              paint: { "background-color": "#e9eee5" },
            },
            {
              id: "basemap",
              type: "raster",
              source: "osm",
              paint: { "raster-saturation": -0.8, "raster-opacity": 0.72 },
            },
          ],
        },
      });
    } catch {
      setError(
        "Map rendering is unavailable. You can still use the property list.",
      );
      return;
    }
    map.current = m;
    m.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      "bottom-right",
    );
    // The rep's own position comes from the device, so it needs no map service.
    m.addControl(
      new maplibregl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: true,
      }),
      "bottom-right",
    );
    m.on("error", (e) => {
      if ((e as unknown as { sourceId?: string }).sourceId === "osm")
        setTileError(true);
    });
    m.on("sourcedata", (e) => {
      if (e.sourceId === "osm" && e.isSourceLoaded) setTileError(false);
    });
    let disposed = false;
    let labels: maplibregl.Marker[] = [];
    refresh.current = () => {
      if (disposed || !m.getSource("parcels")) return;
      const b = m.getBounds(),
        bbox = [
          Math.max(-180, b.getWest()),
          Math.max(-90, b.getSouth()),
          Math.min(180, b.getEast()),
          Math.min(90, b.getNorth()),
        ].join(",");
      latest.current.onBounds(bbox);
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      api<FeatureCollection>(
        `/map?${query({ ...latest.current.filters, bbox, zoom: Math.floor(m.getZoom()) })}`,
        { signal: controller.signal },
      )
        .then((data) => {
          if (disposed || controller.signal.aborted) return;
          (m.getSource("parcels") as GeoJSONSource)?.setData(data);
          labels.forEach((l) => l.remove());
          labels = [];
          for (const f of data.features) {
            if (f.properties?.cluster && f.geometry.type === "Point") {
              const el = document.createElement("div");
              el.className = "cluster-label";
              el.textContent = String(f.properties.point_count_abbreviated);
              el.setAttribute("aria-hidden", "true");
              labels.push(
                new maplibregl.Marker({ element: el })
                  .setLngLat(f.geometry.coordinates as [number, number])
                  .addTo(m),
              );
            }
          }
          setError("");
        })
        .catch((e) => {
          if (e.name !== "AbortError")
            setError(
              "Could not refresh properties on the map. Move the map to retry.",
            );
        });
    };
    m.on("load", () => {
      if (disposed) return;
      m.addSource("parcels", { type: "geojson", data: empty });
      m.addSource("selected", { type: "geojson", data: empty });
      m.addLayer({
        id: "selected-fill",
        type: "fill",
        source: "selected",
        paint: { "fill-color": "#315e43", "fill-opacity": 0.15 },
      });
      m.addLayer({
        id: "selected-line",
        type: "line",
        source: "selected",
        paint: { "line-color": "#264f39", "line-width": 3 },
      });
      m.addLayer({
        id: "clusters",
        type: "circle",
        source: "parcels",
        filter: ["has", "point_count"],
        paint: {
          // Neutral, so green always means High priority.
          "circle-color": "#353c3a",
          "circle-radius": [
            "step",
            ["get", "point_count"],
            19,
            100,
            24,
            1000,
            29,
          ],
          "circle-stroke-width": 5,
          "circle-stroke-color": "rgba(255,255,255,.8)",
        },
      });
      m.addLayer({
        id: "homes",
        type: "circle",
        source: "parcels",
        filter: ["!", ["has", "point_count"]],
        paint: {
          // Unknown is a hollow gray ring so it never reads as a priority.
          "circle-color": [
            "match",
            ["get", "priority"],
            "High",
            "#16704c",
            "Medium",
            "#cf7600",
            "Low",
            "#2f7fe0",
            "#ffffff",
          ],
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            10,
            ["match", ["get", "priority"], "High", 5, 4],
            16,
            ["match", ["get", "priority"], "High", 8.5, 7],
          ],
          "circle-stroke-width": 2,
          "circle-stroke-color": [
            "match",
            ["get", "priority"],
            ["High", "Medium", "Low"],
            "#ffffff",
            "#8a8f8b",
          ],
        },
      });
      for (const layer of ["clusters", "homes"]) {
        m.on("mouseenter", layer, () => {
          m.getCanvas().style.cursor = "pointer";
        });
        m.on("mouseleave", layer, () => {
          m.getCanvas().style.cursor = "";
        });
      }
      m.on("click", "clusters", (e) => {
        const f = e.features?.[0];
        if (f && f.geometry.type === "Point")
          m.easeTo({
            center: f.geometry.coordinates as [number, number],
            zoom: Math.min(
              Number(f.properties?.expansionZoom) || m.getZoom() + 2,
              19,
            ),
          });
      });
      m.on("click", "homes", (e) => {
        const id = e.features?.[0]?.properties?.id;
        if (id) latest.current.onSelect(String(id));
      });
      setLoaded(true);
      refresh.current();
    });
    m.on("moveend", () => refresh.current());
    const resize = new ResizeObserver(() => m.resize());
    resize.observe(el.current);
    return () => {
      disposed = true;
      request.current?.abort();
      resize.disconnect();
      labels.forEach((l) => l.remove());
      m.remove();
      map.current = null;
      setLoaded(false);
    };
  }, []);
  useEffect(() => {
    if (loaded) refresh.current();
  }, [filters, version, loaded]);
  useEffect(() => {
    const m = map.current;
    if (!m || !loaded) return;
    (m.getSource("selected") as GeoJSONSource)?.setData({
      type: "FeatureCollection",
      features: selected?.geometries || [],
    });
    if (selected?.lng != null && selected?.lat != null)
      m.flyTo({
        center: [selected.lng, selected.lat],
        zoom: Math.max(m.getZoom(), 16),
        duration: 800,
      });
  }, [selected?.id, loaded]);
  return (
    <div className="map-wrap">
      <div className="map-canvas" ref={el} />
      <div className="map-location">
        <span className="live-dot" />
        WEBER COUNTY, UTAH
      </div>
      <button
        className="map-reset icon-button"
        title="Show Weber County"
        aria-label="Show Weber County"
        onClick={() =>
          map.current?.flyTo({ center: [-111.974, 41.231], zoom: 10.5 })
        }
      >
        <Maximize size={19} />
      </button>
      <div className="map-legend">
        <span>
          <i className="dot high" />
          High
        </span>
        <span>
          <i className="dot medium" />
          Medium
        </span>
        <span>
          <i className="dot low" />
          Low
        </span>
        <span>
          <i className="dot unknown" />
          Unknown
        </span>
      </div>
      {(error || tileError) && (
        <div className="map-warning" role="status">
          <WifiOff size={16} />
          {error ||
            "Basemap unavailable. Local property data is still accessible."}
        </div>
      )}
    </div>
  );
}

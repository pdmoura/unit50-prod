import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  RotateCw,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { PropertyPhoto } from "../shared/types";

const MIN_ZOOM = 0.5,
  MAX_ZOOM = 6;
const clamp = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
// Cloudinary serves a screen-sized copy; the stored original stays untouched.
const large = (url: string) =>
  url.replace(
    "/image/upload/",
    "/image/upload/c_limit,w_2000,h_2000,q_auto,f_auto/",
  );

// Full-screen photo viewer: zoom (buttons, wheel, pinch, double tap), drag to
// move a zoomed photo, rotate in quarter turns, and step through the photos.
export default function PhotoViewer({
  photos,
  start,
  label,
  onClose,
}: {
  photos: PropertyPhoto[];
  start: number;
  label: string;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(start),
    [zoom, setZoom] = useState(1),
    [turns, setTurns] = useState(0),
    [offset, setOffset] = useState({ x: 0, y: 0 }),
    [stage, setStage] = useState({ width: 0, height: 0 }),
    [loaded, setLoaded] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null),
    closeRef = useRef<HTMLButtonElement>(null),
    pointers = useRef(new Map<number, { x: number; y: number }>()),
    pinch = useRef<{ distance: number; zoom: number } | null>(null);
  const photo = photos[Math.min(index, photos.length - 1)];
  const reset = useCallback(() => {
    setZoom(1);
    setTurns(0);
    setOffset({ x: 0, y: 0 });
  }, []);
  const zoomTo = useCallback((next: number) => {
    const value = clamp(next);
    setZoom(value);
    // A photo that fits the screen has nothing to pan.
    if (value <= 1) setOffset({ x: 0, y: 0 });
  }, []);
  // Relative steps read the latest zoom, so quick repeats never skip or undo one.
  const zoomBy = useCallback((factor: number) => {
    setZoom((z) => {
      const value = clamp(z * factor);
      if (value <= 1) setOffset({ x: 0, y: 0 });
      return value;
    });
  }, []);
  const step = useCallback(
    (by: number) => {
      setIndex((i) => (i + by + photos.length) % photos.length);
      setLoaded(false);
      reset();
    },
    [photos.length, reset],
  );
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, []);
  useEffect(() => {
    // Capture phase, so Escape closes the viewer and not the panel beneath it.
    const onKey = (e: KeyboardEvent) => {
      const actions: Record<string, () => void> = {
        Escape: onClose,
        "+": () => zoomBy(1.4),
        "=": () => zoomBy(1.4),
        "-": () => zoomBy(1 / 1.4),
        "0": reset,
        r: () => setTurns((t) => t + 1),
        R: () => setTurns((t) => t - 1),
        ArrowLeft: () => photos.length > 1 && step(-1),
        ArrowRight: () => photos.length > 1 && step(1),
      };
      const action = actions[e.key];
      if (!action || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      action();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, photos.length, reset, step, zoomBy]);
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () =>
      setStage({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // React attaches wheel listeners as passive, which cannot stop page zoom/scroll.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      observer.disconnect();
      el.removeEventListener("wheel", onWheel);
    };
  }, [zoomBy]);
  const spread = () => {
    const [a, b] = [...pointers.current.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  function onPointerDown(e: React.PointerEvent) {
    // Keeps the drag alive when the finger leaves the photo; not every pointer can be captured.
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2)
      pinch.current = { distance: spread(), zoom };
  }
  function onPointerMove(e: React.PointerEvent) {
    const last = pointers.current.get(e.pointerId);
    if (!last) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && pinch.current)
      zoomTo(pinch.current.zoom * (spread() / pinch.current.distance));
    else if (pointers.current.size === 1 && zoom > 1)
      setOffset((o) => ({
        x: o.x + e.clientX - last.x,
        y: o.y + e.clientY - last.y,
      }));
  }
  function onPointerEnd(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  }
  // After a quarter turn the photo's width runs along the screen's height.
  const sideways = Math.abs(turns) % 2 === 1,
    room = { width: stage.width - 16, height: stage.height - 16 };
  return createPortal(
    <div
      className="photo-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={`Photo ${index + 1} of ${photos.length}, ${label}`}
    >
      <div className="viewer-bar">
        <span className="viewer-count">
          {index + 1} / {photos.length}
        </span>
        <div className="viewer-tools">
          <button
            aria-label="Zoom out"
            title="Zoom out"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => zoomBy(1 / 1.4)}
          >
            <ZoomOut size={19} />
          </button>
          <button
            className="viewer-zoom"
            aria-label="Reset zoom and rotation"
            title="Reset"
            onClick={reset}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            aria-label="Zoom in"
            title="Zoom in"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => zoomBy(1.4)}
          >
            <ZoomIn size={19} />
          </button>
          <button
            aria-label="Rotate left"
            title="Rotate left"
            onClick={() => setTurns((t) => t - 1)}
          >
            <RotateCcw size={19} />
          </button>
          <button
            aria-label="Rotate right"
            title="Rotate right"
            onClick={() => setTurns((t) => t + 1)}
          >
            <RotateCw size={19} />
          </button>
        </div>
        <button
          ref={closeRef}
          aria-label="Close photo"
          title="Close"
          onClick={onClose}
        >
          <X size={21} />
        </button>
      </div>
      <div
        ref={stageRef}
        className={`viewer-stage ${zoom > 1 ? "movable" : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onDoubleClick={() => zoomTo(zoom > 1 ? 1 : 2.5)}
      >
        {!loaded && <span className="viewer-loading">Loading photo…</span>}
        <img
          key={photo.id}
          src={large(photo.url)}
          alt={label}
          draggable={false}
          onLoad={() => setLoaded(true)}
          style={{
            maxWidth: Math.max(0, sideways ? room.height : room.width),
            maxHeight: Math.max(0, sideways ? room.width : room.height),
            transform: `translate(${offset.x}px, ${offset.y}px) rotate(${turns * 90}deg) scale(${zoom})`,
            opacity: loaded ? 1 : 0,
          }}
        />
        {photos.length > 1 && (
          <>
            <button
              className="viewer-step previous"
              aria-label="Previous photo"
              onClick={() => step(-1)}
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <ChevronLeft size={24} />
            </button>
            <button
              className="viewer-step next"
              aria-label="Next photo"
              onClick={() => step(1)}
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <ChevronRight size={24} />
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

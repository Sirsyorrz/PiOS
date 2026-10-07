import { useEffect, useRef } from "react";

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const DOUBLE_TAP_SCALE = 2.5;
/** A press that travels this far is a pan, not a tap. */
const SLOP_PX = 10;
/** Long enough to catch a second tap, short enough that closing feels immediate. */
const DOUBLE_TAP_MS = 260;

type Point = { x: number; y: number };
type View = { scale: number; x: number; y: number };

type Gesture = {
  view: View;
  /** Midpoint of the pointers at the start, in client coordinates. */
  mid: Point;
  /** Finger spread at the start; zero for a one-pointer pan. */
  spread: number;
};

/**
 * Pinch, pan, and double-tap zoom for one element inside a full-screen frame.
 *
 * The frame takes every pointer (`touch-action: none`), so the page itself
 * never zooms: the app is pinned to the visual viewport and a page zoom would
 * shift it. A single tap that is not followed by a second one calls `onTap`.
 * Trackpad pinches arrive as ctrl+wheel and are handled the same way.
 */
export function usePinchZoom<F extends HTMLElement, T extends HTMLElement>(onTap: () => void) {
  const frame = useRef<F>(null);
  const target = useRef<T>(null);
  const tapRef = useRef(onTap);
  tapRef.current = onTap;

  useEffect(() => {
    const box = frame.current;
    const el = target.current;
    if (!box || !el) return;

    let view: View = { scale: 1, x: 0, y: 0 };
    const pointers = new Map<number, Point>();
    let gesture: Gesture | null = null;
    let travelled = 0;
    let multiTouch = false;
    let tapTimer: ReturnType<typeof setTimeout> | null = null;
    let lastTap: Point | null = null;

    const render = (animate: boolean) => {
      el.style.transition = animate ? "transform 180ms ease-out" : "none";
      el.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    };

    /** Layout centre of the target, which the scale is applied around. */
    const origin = (): Point => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2 - view.x, y: r.top + r.height / 2 - view.y };
    };

    /** Keeps the image covering the frame on any axis where it is bigger. */
    const clamp = (next: View): View => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next.scale));
      const frameRect = box.getBoundingClientRect();
      const slackX = Math.max(0, (el.offsetWidth * scale - frameRect.width) / 2);
      const slackY = Math.max(0, (el.offsetHeight * scale - frameRect.height) / 2);
      return {
        scale,
        x: Math.min(slackX, Math.max(-slackX, next.x)),
        y: Math.min(slackY, Math.max(-slackY, next.y)),
      };
    };

    /** Scales to `scale` keeping the content under `from` under `to`. */
    const zoomAt = (start: View, scale: number, from: Point, to: Point): View => {
      const o = origin();
      const k = scale / start.scale;
      return {
        scale,
        x: to.x - o.x - (from.x - o.x - start.x) * k,
        y: to.y - o.y - (from.y - o.y - start.y) * k,
      };
    };

    const begin = () => {
      const pts = [...pointers.values()];
      const [a, b] = pts;
      if (!a) {
        gesture = null;
        return;
      }
      gesture = b
        ? { view, mid: midpoint(a, b), spread: distance(a, b) }
        : { view, mid: a, spread: 0 };
    };

    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest("button")) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      box.setPointerCapture(event.pointerId);
      if (pointers.size === 0) {
        travelled = 0;
        multiTouch = false;
      }
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size > 1) multiTouch = true;
      begin();
    };

    const onMove = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId) || !gesture) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const [a, b] = [...pointers.values()];
      if (!a) return;

      if (b && gesture.spread > 0) {
        const mid = midpoint(a, b);
        const scale = (gesture.view.scale * distance(a, b)) / gesture.spread;
        view = zoomAt(gesture.view, scale, gesture.mid, mid);
        view = { ...view, scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE * 0.8, view.scale)) };
        travelled = Infinity;
      } else {
        const dx = a.x - gesture.mid.x;
        const dy = a.y - gesture.mid.y;
        travelled = Math.max(travelled, Math.hypot(dx, dy));
        if (gesture.view.scale <= 1) return;
        view = clamp({ ...gesture.view, x: gesture.view.x + dx, y: gesture.view.y + dy });
      }
      render(false);
    };

    const onUp = (event: PointerEvent) => {
      if (!pointers.delete(event.pointerId)) return;
      if (pointers.size > 0) {
        begin();
        return;
      }
      gesture = null;
      const settled = clamp(view);
      if (settled.scale !== view.scale || settled.x !== view.x || settled.y !== view.y) {
        view = settled;
        render(true);
      }
      if (event.type === "pointerup" && !multiTouch && travelled <= SLOP_PX) {
        tap({ x: event.clientX, y: event.clientY });
      }
    };

    const tap = (at: Point) => {
      if (tapTimer !== null && lastTap && distance(lastTap, at) < SLOP_PX * 3) {
        clearTimeout(tapTimer);
        tapTimer = null;
        lastTap = null;
        view = view.scale > 1 ? { scale: 1, x: 0, y: 0 } : clamp(zoomAt(view, DOUBLE_TAP_SCALE, at, at));
        render(true);
        return;
      }
      lastTap = at;
      tapTimer = setTimeout(() => {
        tapTimer = null;
        lastTap = null;
        tapRef.current();
      }, DOUBLE_TAP_MS);
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const at = { x: event.clientX, y: event.clientY };
      if (event.ctrlKey) {
        const scale = view.scale * Math.exp(-event.deltaY / 100);
        view = clamp(zoomAt(view, scale, at, at));
      } else if (view.scale > 1) {
        view = clamp({ ...view, x: view.x - event.deltaX, y: view.y - event.deltaY });
      } else {
        return;
      }
      render(false);
    };

    // Safari's own pinch events would zoom the page underneath.
    const block = (event: Event) => event.preventDefault();

    box.addEventListener("pointerdown", onDown);
    box.addEventListener("pointermove", onMove);
    box.addEventListener("pointerup", onUp);
    box.addEventListener("pointercancel", onUp);
    box.addEventListener("wheel", onWheel, { passive: false });
    box.addEventListener("gesturestart", block);
    box.addEventListener("gesturechange", block);
    return () => {
      if (tapTimer !== null) clearTimeout(tapTimer);
      box.removeEventListener("pointerdown", onDown);
      box.removeEventListener("pointermove", onMove);
      box.removeEventListener("pointerup", onUp);
      box.removeEventListener("pointercancel", onUp);
      box.removeEventListener("wheel", onWheel);
      box.removeEventListener("gesturestart", block);
      box.removeEventListener("gesturechange", block);
    };
  }, []);

  return { frame, target };
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

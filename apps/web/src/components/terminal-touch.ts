import type { Terminal } from "@xterm/xterm";

/** Below this speed (px/ms) a released finger stops rather than coasts. */
const FLICK_MIN = 0.3;
/** Per-frame velocity kept while coasting; lower stops sooner. */
const FRICTION = 0.95;

/**
 * One-finger vertical drag scrolls the terminal.
 *
 * xterm.js 6 has no touch scrolling of its own, so a drag otherwise falls
 * through to the page and Safari pans the layout instead. With scrollback the
 * buffer moves; in a full-screen program (alt buffer, or one that asked for
 * the mouse) each line becomes a wheel tick, which xterm turns into whatever
 * that program expects: mouse reports or arrow keys.
 */
export function attachTouchScroll(xterm: Terminal, host: HTMLElement): () => void {
  let lastY = 0;
  let lastT = 0;
  let velocity = 0;
  let pending = 0;
  let dragging = false;
  let coast = 0;

  const cellHeight = () => {
    const screen = xterm.element?.querySelector<HTMLElement>(".xterm-screen");
    const height = screen?.clientHeight ?? host.clientHeight;
    return Math.max(1, height / Math.max(1, xterm.rows));
  };

  // Positive scrolls toward newer output, as a finger moving up does.
  const scrollBy = (pixels: number, at: { clientX: number; clientY: number }) => {
    pending += pixels;
    const step = cellHeight();
    const lines = Math.trunc(pending / step);
    if (!lines) return;
    pending -= lines * step;
    const passThrough = xterm.buffer.active.type === "alternate" || xterm.modes.mouseTrackingMode !== "none";
    if (!passThrough) {
      xterm.scrollLines(lines);
      return;
    }
    const target = xterm.element;
    if (!target) return;
    for (let i = 0; i < Math.abs(lines); i++) {
      target.dispatchEvent(new WheelEvent("wheel", {
        deltaY: Math.sign(lines),
        deltaMode: WheelEvent.DOM_DELTA_LINE,
        clientX: at.clientX,
        clientY: at.clientY,
        bubbles: true,
        cancelable: true,
      }));
    }
  };

  const stopCoast = () => {
    cancelAnimationFrame(coast);
    coast = 0;
  };

  const onStart = (event: TouchEvent) => {
    stopCoast();
    if (event.touches.length !== 1) {
      dragging = false;
      return;
    }
    const touch = event.touches[0]!;
    dragging = true;
    lastY = touch.clientY;
    lastT = event.timeStamp;
    velocity = 0;
    pending = 0;
  };

  const onMove = (event: TouchEvent) => {
    if (!dragging || event.touches.length !== 1) return;
    // Keeps Safari from panning the page under the terminal.
    event.preventDefault();
    const touch = event.touches[0]!;
    const dy = lastY - touch.clientY;
    const dt = Math.max(1, event.timeStamp - lastT);
    velocity = 0.8 * (dy / dt) + 0.2 * velocity;
    lastY = touch.clientY;
    lastT = event.timeStamp;
    scrollBy(dy, touch);
  };

  const onEnd = (event: TouchEvent) => {
    if (!dragging) return;
    dragging = false;
    // A finger that paused before lifting has no flick left in it.
    if (event.timeStamp - lastT > 80 || Math.abs(velocity) < FLICK_MIN) return;
    const at = event.changedTouches[0] ?? { clientX: 0, clientY: 0 };
    const point = { clientX: at.clientX, clientY: at.clientY };
    let previous = performance.now();
    const step = (now: number) => {
      const dt = now - previous;
      previous = now;
      scrollBy(velocity * dt, point);
      velocity *= Math.pow(FRICTION, dt / 16);
      coast = Math.abs(velocity) > 0.02 ? requestAnimationFrame(step) : 0;
    };
    coast = requestAnimationFrame(step);
  };

  const onCancel = () => {
    dragging = false;
  };

  const options = { passive: false, capture: true } as const;
  host.addEventListener("touchstart", onStart, options);
  host.addEventListener("touchmove", onMove, options);
  host.addEventListener("touchend", onEnd, options);
  host.addEventListener("touchcancel", onCancel, options);
  return () => {
    stopCoast();
    host.removeEventListener("touchstart", onStart, options);
    host.removeEventListener("touchmove", onMove, options);
    host.removeEventListener("touchend", onEnd, options);
    host.removeEventListener("touchcancel", onCancel, options);
  };
}

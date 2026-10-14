import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** Within this much of the bottom still counts as "reading the tail". */
const BOTTOM_SLACK = 48;

/** How long scroll events after a lift still count as the reader's fling. */
const FLING_MS = 1200;

/** Long enough for a smooth scroll to land; past it the tail is snapped to. */
const GLIDE_MS = 600;

/**
 * Keeps a scroller pinned to its last line until the reader scrolls away, and
 * never moves it again after that.
 *
 * Only the reader can unpin it. Content arrives in bursts while a session
 * opens, images decode late, iOS clamps and re-clamps the offset: each of
 * those fires scroll events that land away from the bottom, and reading them
 * as "the reader left" strands the view mid-transcript. So position is only
 * trusted while a finger, wheel or key is moving it.
 *
 * The pane shrinks whenever the keyboard opens or the dock above it grows. A
 * scroller left at the same scrollTop pushes its tail down behind the dock, so
 * a pinned pane is re-pinned and an unpinned one is shifted by the same amount
 * the bottom edge moved: either way the line under the dock stays put.
 *
 * The scroller is taken through a callback ref because it remounts whenever
 * the chat swaps in another view, and observers left on the old node would
 * watch nothing.
 */
export function useStickToBottom<T>(marker: T) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const stuck = useRef(true);
  // A finger on the glass owns the scroll position: writing scrollTop under it
  // makes the page jump back, and on iOS it also kills the fling.
  const touching = useRef(false);
  // Until then, scroll events are the reader's fling or wheel.
  const userUntil = useRef(0);
  // The "scroll to latest" glide in flight. Restarting it on every streamed
  // delta would keep it at its slow start forever, so it runs once and the
  // tail is snapped to when it ends.
  const gliding = useRef(false);
  const glideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const height = useRef(0);
  // Mirrors `stuck` for rendering only: the ref drives the pinning, which must
  // not wait for a render.
  const [atBottom, setAtBottom] = useState(true);

  const pin = useCallback(() => {
    if (!el || touching.current) return;
    height.current = el.clientHeight;
    if (gliding.current) return;
    // Over-scroll is clamped by the browser, so no scrollHeight math here.
    el.scrollTop = el.scrollHeight;
    setAtBottom(true);
  }, [el]);

  const onScroll = useCallback(() => {
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
    if (gliding.current) {
      // Mid-glide the position is ours, not the reader's.
      if (!near) return;
      gliding.current = false;
    }
    const byReader = touching.current || performance.now() < userUntil.current;
    if (!byReader) {
      // Layout moved the offset, not the reader: a pinned pane goes back.
      if (stuck.current && !near) pin();
      return;
    }
    stuck.current = near;
    setAtBottom(near);
  }, [el, pin]);

  /** Reader-driven glide back to the tail. */
  const scrollToBottom = useCallback(() => {
    if (!el) return;
    stuck.current = true;
    gliding.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    clearTimeout(glideTimer.current);
    glideTimer.current = setTimeout(() => {
      if (!gliding.current) return;
      gliding.current = false;
      if (stuck.current) pin();
    }, GLIDE_MS);
  }, [el, pin]);

  // Layout effect, not effect: the pin has to land in the same frame as the
  // new content, otherwise the transcript visibly jumps.
  useLayoutEffect(() => {
    if (stuck.current) pin();
  }, [marker, pin]);

  useLayoutEffect(() => {
    if (!el) return;
    height.current = el.clientHeight;
    pin();

    const resize = new ResizeObserver(() => {
      const delta = height.current - el.clientHeight;
      height.current = el.clientHeight;
      if (stuck.current) pin();
      else if (delta !== 0 && !touching.current) el.scrollTop += delta;
    });
    resize.observe(el);
    // Content grows without a new render too: an image decodes, a card opens.
    const observeChildren = () => {
      for (const child of el.children) resize.observe(child);
    };
    observeChildren();
    const children = new MutationObserver(observeChildren);
    children.observe(el, { childList: true });

    const grab = () => {
      touching.current = true;
      gliding.current = false;
    };
    const release = () => {
      if (!touching.current) return;
      touching.current = false;
      userUntil.current = performance.now() + FLING_MS;
      // Momentum scroll events settle `stuck` from here; this covers a lift
      // with no fling, after content arrived under the finger.
      if (stuck.current) pin();
    };
    const steer = (event: Event) => {
      gliding.current = false;
      userUntil.current = performance.now() + FLING_MS;
      // Scrolling up leaves the tail at once, before the slack would.
      if (event instanceof WheelEvent && event.deltaY < 0) {
        stuck.current = false;
        setAtBottom(false);
      }
    };
    // A mouse drags the scrollbar with no wheel or touch event at all.
    const press = (event: PointerEvent) => {
      if (event.pointerType === "mouse") grab();
    };
    el.addEventListener("touchstart", grab, { passive: true });
    el.addEventListener("pointerdown", press);
    window.addEventListener("pointerup", release);
    el.addEventListener("wheel", steer, { passive: true });
    el.addEventListener("keydown", steer);
    // On the window: a touch keeps its first target, and a streamed bubble is
    // often replaced under the finger, so the lift never bubbles back here.
    window.addEventListener("touchend", release, { passive: true });
    window.addEventListener("touchcancel", release, { passive: true });
    return () => {
      clearTimeout(glideTimer.current);
      resize.disconnect();
      children.disconnect();
      el.removeEventListener("touchstart", grab);
      el.removeEventListener("pointerdown", press);
      window.removeEventListener("pointerup", release);
      el.removeEventListener("wheel", steer);
      el.removeEventListener("keydown", steer);
      window.removeEventListener("touchend", release);
      window.removeEventListener("touchcancel", release);
    };
  }, [el, pin]);

  /** Re-pin after something outside the scroller changed its scrollHeight. */
  const settle = useCallback(() => {
    if (stuck.current) pin();
  }, [pin]);

  return { ref: setEl, onScroll, settle, atBottom, scrollToBottom };
}

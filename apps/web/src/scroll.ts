import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** Within this much of the bottom still counts as "reading the tail". */
const BOTTOM_SLACK = 48;
/** Quiet time after which a glide counts as landed. */
const GLIDE_SETTLE_MS = 120;

/**
 * Keeps a scroller pinned to its last line until the reader scrolls away, and
 * never moves it again after that.
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
  // Set by the "scroll to latest" glide, which has to keep chasing a tail that
  // grows while it travels.
  const gliding = useRef(false);
  const landing = useRef<ReturnType<typeof setTimeout>>(undefined);
  const height = useRef(0);
  // Mirrors `stuck` for rendering only: the ref drives the pinning, which must
  // not wait for a render.
  const [atBottom, setAtBottom] = useState(true);

  const pin = useCallback(() => {
    // A glide in flight is left to land: restarting it on every delta
    // restarts its easing too, and it never gets anywhere.
    if (!el || touching.current || gliding.current) return;
    height.current = el.clientHeight;
    // Over-scroll is clamped by the browser, so no scrollHeight math here.
    el.scrollTop = el.scrollHeight;
    setAtBottom(true);
  }, [el]);

  const land = useCallback((after: number) => {
    clearTimeout(landing.current);
    landing.current = setTimeout(() => {
      gliding.current = false;
      stuck.current = true;
      pin();
    }, after);
  }, [pin]);

  const onScroll = useCallback(() => {
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
    if (gliding.current) {
      // Mid-glide the position is ours, not the reader's. The tail it aimed
      // at has usually moved by the time it lands, so the landing is a pin.
      // A pause in scroll events marks it: Safari has no `scrollend`.
      land(GLIDE_SETTLE_MS);
      return;
    }
    stuck.current = near;
    setAtBottom(near);
  }, [el, land]);

  /** Reader-driven glide back to the tail. */
  const scrollToBottom = useCallback(() => {
    if (!el) return;
    gliding.current = true;
    stuck.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    // Lands even if the glide never produces a scroll event.
    land(GLIDE_SETTLE_MS * 3);
  }, [el, land]);

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
      clearTimeout(landing.current);
    };
    const release = () => {
      touching.current = false;
      // Momentum scroll events settle `stuck` from here; this covers a lift
      // with no fling, after content arrived under the finger.
      if (stuck.current) pin();
    };
    // Scrolling up by wheel leaves the tail at once, before the slack would.
    const wheel = (event: WheelEvent) => {
      if (event.deltaY >= 0) return;
      gliding.current = false;
      clearTimeout(landing.current);
      stuck.current = false;
      setAtBottom(false);
    };
    el.addEventListener("touchstart", grab, { passive: true });
    el.addEventListener("touchend", release, { passive: true });
    el.addEventListener("touchcancel", release, { passive: true });
    el.addEventListener("wheel", wheel, { passive: true });
    return () => {
      clearTimeout(landing.current);
      resize.disconnect();
      children.disconnect();
      el.removeEventListener("touchstart", grab);
      el.removeEventListener("touchend", release);
      el.removeEventListener("touchcancel", release);
      el.removeEventListener("wheel", wheel);
    };
  }, [el, pin]);

  /** Re-pin after something outside the scroller changed its scrollHeight. */
  const settle = useCallback(() => {
    if (stuck.current) pin();
  }, [pin]);

  return { ref: setEl, onScroll, settle, atBottom, scrollToBottom };
}

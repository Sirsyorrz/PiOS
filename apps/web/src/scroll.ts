import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** Within this much of the bottom still counts as "reading the tail". */
const BOTTOM_SLACK = 48;

/**
 * Keeps a scroller pinned to its last line until the reader scrolls away, and
 * never moves it again after that.
 *
 * The pane shrinks whenever the keyboard opens or the dock above it grows. A
 * scroller left at the same scrollTop pushes its tail down behind the dock, so
 * a pinned pane is re-pinned and an unpinned one is shifted by the same amount
 * the bottom edge moved: either way the line under the dock stays put.
 */
export function useStickToBottom<T>(marker: T) {
  const ref = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const height = useRef(0);
  // Mirrors `stuck` for rendering only: the ref drives the pinning, which must
  // not wait for a render.
  const [atBottom, setAtBottom] = useState(true);

  const pin = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // Over-scroll is clamped by the browser, so no scrollHeight math here.
    el.scrollTop = el.scrollHeight;
    height.current = el.clientHeight;
    setAtBottom(true);
  }, []);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
    setAtBottom(stuck.current);
  }, []);

  /**
   * Reader-driven glide back to the tail. `stuck` is left alone: a hard pin
   * mid-animation would cancel it, and the scroll handler flips it as soon as
   * the animation actually arrives.
   */
  const scrollToBottom = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  // Layout effect, not effect: the pin has to land in the same frame as the
  // new content, otherwise the transcript visibly jumps.
  useLayoutEffect(() => {
    if (stuck.current) pin();
  }, [marker, pin]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    height.current = el.clientHeight;
    pin();
    const resize = new ResizeObserver(() => {
      const delta = height.current - el.clientHeight;
      height.current = el.clientHeight;
      if (stuck.current) pin();
      else if (delta !== 0) el.scrollTop += delta;
    });
    resize.observe(el);
    return () => resize.disconnect();
  }, [pin]);

  /** Re-pin after something outside the scroller changed its scrollHeight. */
  const settle = useCallback(() => {
    if (stuck.current) pin();
  }, [pin]);

  return { ref, onScroll, settle, atBottom, scrollToBottom };
}

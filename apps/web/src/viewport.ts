/* iOS does not resize the layout viewport for the software keyboard: 100dvh
   stays tall and a fixed composer ends up underneath the keys. The visual
   viewport does move, so the app box is pinned to it instead. */

const MIN_KEYBOARD = 120;

export function trackViewport(): void {
  const root = document.documentElement;
  const vv = window.visualViewport;

  const apply = () => {
    const height = vv ? vv.height : window.innerHeight;
    const offset = vv ? vv.offsetTop : 0;
    // Anything the visual viewport lost to an overlay is assumed to be the
    // keyboard; below that threshold it is just collapsing browser chrome.
    const hidden = window.innerHeight - height - offset;
    const keyboard = hidden > MIN_KEYBOARD;

    root.style.setProperty("--app-height", `${height}px`);
    root.style.setProperty("--app-offset", `${offset}px`);
    // The home indicator is covered by the keyboard, so its inset would only
    // add dead space under the composer.
    root.dataset.keyboard = keyboard ? "1" : "0";
  };

  // Focusing the composer makes the browser scroll its ancestors to reveal it,
  // and the app box is one of them: `overflow: hidden` stops the reader from
  // scrolling it, not the browser. Left alone it drifts a little further on
  // every focus/blur, so it is pushed back every time.
  const unscroll = (event: Event) => {
    const box = event.target;
    if (!(box instanceof HTMLElement) || box.id !== "root") return;
    box.scrollTop = 0;
    box.scrollLeft = 0;
  };

  apply();
  // Capture, because a scroll event does not bubble.
  document.addEventListener("scroll", unscroll, true);
  vv?.addEventListener("resize", apply);
  vv?.addEventListener("scroll", apply);
  window.addEventListener("resize", apply);
  window.addEventListener("orientationchange", apply);
}

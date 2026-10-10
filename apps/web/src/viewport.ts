/* iOS does not resize the layout viewport for the software keyboard: 100dvh
   stays tall and a fixed composer ends up underneath the keys. The visual
   viewport does move, so the app box is pinned to it instead. */

const MIN_KEYBOARD = 120;

/** Whether the focused element is one that raises the software keyboard. */
function editing(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  if (active.isContentEditable || active instanceof HTMLTextAreaElement) return true;
  if (!(active instanceof HTMLInputElement)) return false;
  return !["button", "checkbox", "radio", "range", "color", "file", "submit", "reset", "image"].includes(active.type);
}

export function trackViewport(): void {
  const root = document.documentElement;
  const vv = window.visualViewport;
  // Android shrinks the layout viewport along with the visual one, so the
  // keyboard only shows up as a drop from the tallest height seen.
  let tallest = 0;
  let wasKeyboard = false;

  const apply = () => {
    // With nothing to type into there is no keyboard, whatever the viewport
    // says. On a return from the background iOS can keep reporting the height
    // it had with the keyboard up, and fire nothing to correct it, which
    // leaves the composer floating mid-screen. So the CSS full height is used
    // and the stale numbers are never consulted.
    if (!editing()) {
      root.style.removeProperty("--app-height");
      root.style.removeProperty("--app-offset");
      root.dataset.keyboard = "0";
      return;
    }
    const height = vv ? vv.height : window.innerHeight;
    const offset = vv ? vv.offsetTop : 0;
    // Anything the visual viewport lost to an overlay is assumed to be the
    // keyboard; below that threshold it is just collapsing browser chrome.
    const hidden = window.innerHeight - height - offset;
    tallest = Math.max(tallest, height);
    const keyboard = hidden > MIN_KEYBOARD || tallest - height > MIN_KEYBOARD;

    // Android's keyboard-hide key leaves the field focused, and everything
    // that collapses while typing stays collapsed until it blurs.
    if (wasKeyboard && !keyboard) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.matches("input, textarea, [contenteditable]")) {
        active.blur();
      }
    }
    wasKeyboard = keyboard;

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

  // iOS settles the viewport a few frames after it says anything, so a change
  // that could move the keyboard is measured again after it lands. Not
  // synchronously: during a focus hop between two fields nothing is focused,
  // and measuring then would drop the app to full height for a frame.
  const settle = () => {
    for (const delay of [0, 50, 150, 400, 800]) setTimeout(apply, delay);
  };

  // A field focused when the app is backgrounded comes back focused with no
  // keyboard, so it is released on the way out rather than left to that.
  const onVisibility = () => {
    if (document.visibilityState === "hidden") {
      if (editing()) (document.activeElement as HTMLElement).blur();
      return;
    }
    settle();
  };

  apply();
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pageshow", settle);
  window.addEventListener("focus", settle);
  document.addEventListener("focusin", settle);
  document.addEventListener("focusout", settle);
  // Capture, because a scroll event does not bubble.
  document.addEventListener("scroll", unscroll, true);
  vv?.addEventListener("resize", apply);
  vv?.addEventListener("scroll", apply);
  window.addEventListener("resize", apply);
  window.addEventListener("orientationchange", () => {
    tallest = 0;
    apply();
  });
}

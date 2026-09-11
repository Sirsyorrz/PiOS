import { useRef, type TouchEvent } from "react";

/** Only a drag that starts in the gutter counts, so text selection and
    horizontal scrolling inside the transcript keep working. */
const EDGE_PX = 28;
/** Far enough that a diagonal scroll never dismisses the session. */
const DISTANCE_PX = 70;
/** The drag has to be mostly sideways, not a flick down the transcript. */
const DOMINANCE = 1.6;
/** Below this width the panes are exclusive, so back has somewhere to go. */
const ONE_PANE = "(max-width: 720px)";

/**
 * Handlers for an iOS-style back swipe from the left edge.
 *
 * Touch events rather than pointer events: the browser's own gesture
 * arbitration already fires these after it decides the drag is not a scroll,
 * and a mouse has the back button.
 */
export function useEdgeSwipe(onBack: () => void) {
  const origin = useRef<{ x: number; y: number } | null>(null);

  return {
    onTouchStart(event: TouchEvent) {
      origin.current = null;
      if (event.touches.length !== 1) return;
      if (!window.matchMedia(ONE_PANE).matches) return;
      const touch = event.touches[0];
      if (!touch || touch.clientX > EDGE_PX) return;
      origin.current = { x: touch.clientX, y: touch.clientY };
    },
    onTouchMove(event: TouchEvent) {
      const start = origin.current;
      if (!start) return;
      // A second finger means a pinch or a scroll, not a back gesture.
      if (event.touches.length !== 1) {
        origin.current = null;
        return;
      }
      const touch = event.touches[0];
      if (!touch) return;
      const dx = touch.clientX - start.x;
      const dy = Math.abs(touch.clientY - start.y);
      if (dx < 0 || dy > Math.abs(dx)) {
        origin.current = null;
        return;
      }
      if (dx > DISTANCE_PX && dx > dy * DOMINANCE) {
        origin.current = null;
        onBack();
      }
    },
    onTouchEnd() {
      origin.current = null;
    },
    onTouchCancel() {
      origin.current = null;
    },
  };
}

import { useEffect, useState } from "react";
import { isDirectSrc, useFileObjectUrl } from "../files.ts";
import { usePinchZoom } from "../pinch-zoom.ts";
import { CloseIcon } from "./icons.tsx";

/**
 * An image in the transcript.
 *
 * `src` is either something the browser can load itself (a data URL from an
 * attachment, an http link) or a path on the machine, which only the daemon
 * can serve. A failure is shown as text: a broken image icon says nothing
 * about which file was missing.
 */
export function TranscriptImage({ src, alt }: { src: string; alt: string }) {
  const direct = isDirectSrc(src);
  const fetched = useFileObjectUrl(direct ? null : src);
  const [open, setOpen] = useState(false);
  const url = direct ? src : fetched.url;

  if (fetched.error) {
    return (
      <span className="image-missing muted line" title={src}>
        {alt || src} ({fetched.error})
      </span>
    );
  }
  if (!url) return <span className="image-loading" aria-label={alt || "loading image"} />;

  return (
    <>
      <img className="attachment" alt={alt} src={url} onClick={() => setOpen(true)} />
      {open ? <Lightbox url={url} alt={alt} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** Full-bleed view. Pinch or double-tap to zoom; a single tap or Escape leaves. */
function Lightbox({ url, alt, onClose }: { url: string; alt: string; onClose: () => void }) {
  const { frame, target } = usePinchZoom<HTMLDivElement, HTMLImageElement>(onClose);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  return (
    <div className="lightbox" ref={frame}>
      <button type="button" className="icon ghost" aria-label="close" onClick={onClose}>
        <CloseIcon />
      </button>
      <img ref={target} alt={alt} src={url} draggable={false} />
    </div>
  );
}

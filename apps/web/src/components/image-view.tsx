import { imageSize, type ImageContent, type ImageSize } from "@pios/protocol";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { IMAGE_REF, isDirectSrc, useFileObjectUrl } from "../files.ts";
import { usePinchZoom } from "../pinch-zoom.ts";
import { CloseIcon } from "./icons.tsx";

/**
 * An image part of a message: inline bytes, or a name the daemon serves.
 *
 * A named image arrives with its pixel size, so its box is laid out at full
 * size at once and the bytes are only fetched as it nears the screen.
 */
export function PartImage({ image, alt }: { image: ImageContent; alt: string }) {
  const src = image.ref ? `${IMAGE_REF}${image.ref}` : `data:${image.mimeType};base64,${image.data}`;
  const size = image.width && image.height ? { width: image.width, height: image.height } : undefined;
  return <TranscriptImage src={src} alt={alt} size={size} />;
}

/**
 * An image in the transcript.
 *
 * `src` is something the browser can load itself (a data URL, an http link),
 * an image the daemon holds by name, or a path on the machine, which only the
 * daemon can serve. A failure is shown as text: a broken image icon says
 * nothing about which file was missing.
 */
export function TranscriptImage({ src, alt, size: known }: { src: string; alt: string; size?: ImageSize }) {
  const direct = isDirectSrc(src);
  // Read from the header bytes otherwise, so the row is reserved before the
  // decode and the transcript does not shift under the reader when it lands.
  const size = useMemo(() => known ?? (direct ? dataUrlSize(src) : null), [known, direct, src]);
  const [box, near] = useNearScreen<HTMLSpanElement>(Boolean(size) && !direct);
  const fetched = useFileObjectUrl(direct || !near ? null : src);
  const [open, setOpen] = useState(false);
  const url = direct ? src : fetched.url;

  if (fetched.error) {
    return (
      <span className="image-missing muted line" title={src}>
        {alt || src} ({fetched.error})
      </span>
    );
  }
  if (!url) {
    return size ? (
      <span
        ref={box}
        className="attachment sized image-loading"
        style={sizedStyle(size)}
        aria-label={alt || "loading image"}
      />
    ) : (
      <span className="image-loading" aria-label={alt || "loading image"} />
    );
  }

  return (
    <>
      <img
        className={size ? "attachment sized" : "attachment"}
        alt={alt}
        src={url}
        width={size?.width}
        height={size?.height}
        style={size ? sizedStyle(size) : undefined}
        // Off-screen images cost a phone their decoded bitmap; a reserved box
        // makes deferring them safe.
        loading={size ? "lazy" : undefined}
        decoding="async"
        onClick={() => setOpen(true)}
      />
      {open ? <Lightbox url={url} alt={alt} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** How far off screen a fetch starts, so a flick lands on loaded images. */
const NEAR_MARGIN = "1500px 0px";

/**
 * Whether an element is on or near the screen, latched once it has been.
 * With `watch` off it reports near at once: nothing is deferred.
 */
function useNearScreen<T extends Element>(watch: boolean) {
  const [el, setEl] = useState<T | null>(null);
  const [near, setNear] = useState(!watch);
  useEffect(() => {
    if (!watch || near || !el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: NEAR_MARGIN },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [watch, near, el]);
  return [setEl, near || !watch] as const;
}

function sizedStyle({ width, height }: ImageSize): CSSProperties {
  return { "--ratio": width / height, "--w": `${width}px` } as CSSProperties;
}

function dataUrlSize(src: string): ImageSize | null {
  const match = /^data:([^;,]+);base64,/i.exec(src);
  return match ? imageSize(match[1]!, src.slice(match[0].length)) : null;
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

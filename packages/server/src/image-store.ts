import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { imageSize } from "@pios/protocol";

/** Smaller than this, a fetch costs more than the bytes it saves. */
const INLINE_MAX_CHARS = 16 * 1024;
/** Images nobody has sent for this long are dropped; a resend writes them back. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** What a stored image's name looks like; anything else is not ours to serve. */
const NAME = /^[0-9a-f]{64}\.(png|jpg|gif|webp)$/;

export const IMAGE_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

interface ImagePart {
  type: "image";
  data: string;
  mimeType: string;
}

/**
 * Images sent by name instead of inline.
 *
 * A screenshot is a megabyte of base64, and a transcript page or a replayed
 * turn carried every one of them whether or not the phone ever scrolled to
 * it. Here each is written once, under its content hash, and the frame
 * carries the name and pixel size; the client fetches the bytes when the
 * image is about to be seen.
 */
export class ImageStore {
  private readonly dir: string;
  /** Per source object, so a buffered event replayed to ten devices is hashed once. */
  private readonly replaced = new WeakMap<object, unknown>();

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.prune();
  }

  /**
   * `value` with every large inline image swapped for a reference.
   *
   * Copy on write: untouched branches are returned as they are, so a frame
   * with no images costs a walk and nothing else.
   */
  externalize<T>(value: T): T {
    return this.walk(value) as T;
  }

  /** Path of a stored image, or null for a name that is not one. */
  path(name: string): string | null {
    if (!NAME.test(name)) return null;
    const path = join(this.dir, name);
    return existsSync(path) ? path : null;
  }

  private walk(value: unknown): unknown {
    if (value === null || typeof value !== "object") return value;
    const cached = this.replaced.get(value);
    if (cached !== undefined) return cached;

    let result: unknown = value;
    if (isLargeImage(value)) {
      result = this.store(value);
    } else if (Array.isArray(value)) {
      let copy: unknown[] | null = null;
      value.forEach((item, index) => {
        const next = this.walk(item);
        if (next !== item) (copy ??= value.slice())[index] = next;
      });
      if (copy) result = copy;
    } else {
      let copy: Record<string, unknown> | null = null;
      for (const [key, item] of Object.entries(value)) {
        const next = this.walk(item);
        if (next !== item) (copy ??= { ...value })[key] = next;
      }
      if (copy) result = copy;
    }
    this.replaced.set(value, result);
    return result;
  }

  private store(image: ImagePart): unknown {
    const ext = EXTENSIONS[image.mimeType.toLowerCase()];
    if (!ext) return image;
    const name = `${createHash("sha256").update(image.data).digest("hex")}.${ext}`;
    const path = join(this.dir, name);
    if (!existsSync(path)) writeFileSync(path, Buffer.from(image.data, "base64"), { mode: 0o600 });
    // Still in use, so not one for the prune; once per process per image.
    else utimesSync(path, new Date(), new Date());
    const size = imageSize(image.mimeType, image.data);
    const { data: _data, ...rest } = image;
    return { ...rest, data: "", ref: name, ...(size ?? {}) };
  }

  private prune(now = Date.now()): void {
    for (const name of readdirSync(this.dir)) {
      if (!NAME.test(name)) continue;
      const path = join(this.dir, name);
      try {
        if (now - statSync(path).mtimeMs > KEEP_MS) unlinkSync(path);
      } catch {
        // Gone already, or unreadable: either way not worth failing startup.
      }
    }
  }
}

function isLargeImage(value: object): value is ImagePart {
  const part = value as Partial<ImagePart>;
  return (
    part.type === "image" &&
    typeof part.data === "string" &&
    typeof part.mimeType === "string" &&
    part.data.length > INLINE_MAX_CHARS
  );
}

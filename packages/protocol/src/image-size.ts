export interface ImageSize {
  width: number;
  height: number;
}

/** Enough base64 to reach a JPEG's frame header past typical metadata. */
const HEADER_CHARS = 87_384;

/** Pixel size of base64 image bytes, for the formats agents produce. */
export function imageSize(mimeType: string, base64: string): ImageSize | null {
  const format = /^image\/(png|gif|jpeg|jpg)$/i.exec(mimeType)?.[1]?.toLowerCase();
  if (!format) return null;
  let bytes: Uint8Array;
  try {
    const head = base64.slice(0, HEADER_CHARS);
    const binary = atob(head.slice(0, head.length - (head.length % 4)));
    bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  const size = readSize(format, bytes);
  return size && size.width > 0 && size.height > 0 ? size : null;
}

function readSize(format: string, b: Uint8Array): ImageSize | null {
  const be16 = (i: number) => (b[i]! << 8) | b[i + 1]!;
  const be32 = (i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
  if (format === "png") {
    if (b.length < 24 || b[12] !== 0x49 || b[13] !== 0x48) return null;
    return { width: be32(16), height: be32(20) };
  }
  if (format === "gif") {
    if (b.length < 10) return null;
    return { width: b[6]! | (b[7]! << 8), height: b[8]! | (b[9]! << 8) };
  }
  // JPEG: walk the segments to the first start-of-frame.
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return { width: be16(i + 7), height: be16(i + 5) };
    i += 2 + be16(i + 2);
  }
  return null;
}

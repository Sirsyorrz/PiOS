import type { SVGProps } from "react";

/**
 * Inline strokes rather than an icon font or a sprite: a handful of glyphs is
 * cheaper as markup than as another asset to load, and they inherit
 * `currentColor` so a button's state styles the icon for free.
 */
function Svg({ children, ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function EyeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" />
      <circle cx="12" cy="12" r="2.75" />
    </Svg>
  );
}

export function EyeOffIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M3 3l18 18" />
      <path d="M10.6 6.7A9.9 9.9 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-3.4 4.1" />
      <path d="M6.4 8A17 17 0 0 0 2 12s3.6 6.5 10 6.5c1.5 0 2.8-.3 4-.9" />
      <path d="M9.9 9.9a2.75 2.75 0 0 0 3.9 3.9" />
    </Svg>
  );
}

export function ChevronRightIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M9 5l7 7-7 7" />
    </Svg>
  );
}

export function ChevronLeftIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M15 5l-7 7 7 7" />
    </Svg>
  );
}

export function PlusIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function HistoryIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
      <path d="M3 4v4.5h4.5" />
      <path d="M12 7.5V12l3 1.8" />
    </Svg>
  );
}

export function TrashIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M4 6.5h16" />
      <path d="M9.5 6.5V4.8h5v1.7" />
      <path d="M6.5 6.5 7.4 20h9.2l.9-13.5" />
    </Svg>
  );
}

export function SendIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M12 19V5" />
      <path d="M6 11l6-6 6 6" />
    </Svg>
  );
}

export function StopIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function ChevronDownIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M5 9l7 7 7-7" />
    </Svg>
  );
}

/** Falls back to a generic glyph so an unmapped tool still reads as a tool. */
export function ToolIcon({ name, ...rest }: { name: string } & SVGProps<SVGSVGElement>) {
  const kind = name.toLowerCase();
  if (kind.includes("bash") || kind.includes("shell") || kind.includes("exec")) {
    return (
      <Svg {...rest}>
        <path d="M5 7l4.5 4.5L5 16" />
        <path d="M12 16.5h7" />
      </Svg>
    );
  }
  if (kind.includes("edit") || kind.includes("write") || kind.includes("patch")) {
    return (
      <Svg {...rest}>
        <path d="M4 20h4l10-10a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5 4 20Z" />
      </Svg>
    );
  }
  if (kind.includes("read") || kind.includes("file") || kind.includes("cat")) {
    return (
      <Svg {...rest}>
        <path d="M6 3.5h7.5L19 9v11.5H6Z" />
        <path d="M13.5 3.5V9H19" />
      </Svg>
    );
  }
  if (kind.includes("search") || kind.includes("grep") || kind.includes("find") || kind.includes("glob")) {
    return (
      <Svg {...rest}>
        <circle cx="11" cy="11" r="6" />
        <path d="M15.5 15.5 20 20" />
      </Svg>
    );
  }
  if (kind.includes("web") || kind.includes("fetch") || kind.includes("http")) {
    return (
      <Svg {...rest}>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M3.5 12h17M12 3.5c2.2 2.4 3.3 5.4 3.3 8.5S14.2 18.1 12 20.5c-2.2-2.4-3.3-5.4-3.3-8.5S9.8 5.9 12 3.5Z" />
      </Svg>
    );
  }
  return (
    <Svg {...rest}>
      <path d="M14.5 3.5a5 5 0 0 0-4.2 7.6L4 17.4V20h2.6l6.3-6.3a5 5 0 0 0 6.4-6.6l-2.9 2.9-2.4-2.4 2.9-2.9a5 5 0 0 0-2.4-1.2Z" />
    </Svg>
  );
}

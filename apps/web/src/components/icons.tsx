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

export function CopyIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2" />
    </Svg>
  );
}

export function CheckIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M4.5 12.5 9.5 17.5 19.5 6.5" />
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

export function MinusIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M5 12h14" />
    </Svg>
  );
}

/** Two commits on a branch line: the one glyph that reads as "git". */
export function BranchIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="7" r="2.5" />
      <path d="M6 8.5v7M18 9.5c0 4-4 3.5-6 6.5" />
    </Svg>
  );
}

export function DownloadIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M12 4v11m0 0 4-4m-4 4-4-4M5 19h14" />
    </Svg>
  );
}

export function UploadIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M12 20V9m0 0 4 4m-4-4-4 4M5 5h14" />
    </Svg>
  );
}

export function RefreshIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M20 11a8 8 0 1 0-.6 4M20 5v6h-6" />
    </Svg>
  );
}

/** A box with a lid: the stash. */
export function ArchiveIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M3 7h18v4H3zM5 11v8h14v-8M10 15h4" />
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

export function FolderIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h3.8l2 2.5H19a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5Z" />
    </Svg>
  );
}

/** The parent directory: a folder you step out into, not one you step into. */
export function FolderUpIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h3.8l2 2.5H19a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5Z" />
      <path d="M12 16v-5" />
      <path d="M9.6 13.2 12 10.8l2.4 2.4" />
    </Svg>
  );
}

export function FileIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M6.5 3.5h7l4.5 4.5v12a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z" />
      <path d="M13.5 3.5V8h4.5" />
    </Svg>
  );
}

export function UndoIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M4 9h10a5 5 0 0 1 0 10H9" />
      <path d="m7.5 5.5-3.5 3.5 3.5 3.5" />
    </Svg>
  );
}

export function RedoIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M20 9H10a5 5 0 0 0 0 10h5" />
      <path d="m16.5 5.5 3.5 3.5-3.5 3.5" />
    </Svg>
  );
}

export function SearchIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="6" />
      <path d="m15.5 15.5 4 4" />
    </Svg>
  );
}

export function CloseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  );
}

export function ClockIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 1.8" />
    </Svg>
  );
}

export function MessageIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M4.5 6.5A1.5 1.5 0 0 1 6 5h12a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 18 16H9l-4.5 3.5Z" />
    </Svg>
  );
}

/** Sliders, not a gear: the settings screen is a list of choices. */
export function SettingsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
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

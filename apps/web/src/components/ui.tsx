import type { FormEvent, MouseEventHandler, ReactNode } from "react";
import { CloseIcon, SearchIcon } from "./icons.tsx";

function withBase(base: string, className?: string): string {
  return className ? `${base} ${className}` : base;
}

/**
 * A full-screen step: one card, centered. Every pre-chat screen (pairing,
 * pickers) is one of these, so they stay visually identical by construction.
 */
export function ModalCard({ className, overlay, onSubmit, children }: {
  className?: string;
  /** Floats above the chat instead of replacing it, for in-session steps. */
  overlay?: boolean;
  onSubmit?: (event: FormEvent) => void;
  children: ReactNode;
}) {
  const cls = withBase("card", className);
  return (
    <div className={overlay ? "screen centered overlay" : "screen centered"}>
      {onSubmit ? (
        <form className={cls} onSubmit={onSubmit}>
          {children}
        </form>
      ) : (
        <section className={cls}>{children}</section>
      )}
    </div>
  );
}

/**
 * A full-width, left-aligned, stacked-content tap target: session rows,
 * endpoint rows, directory rows. One style so lists cannot drift apart.
 */
export function ListRowButton({ className, onClick, onMouseDown, icon, trailing, children }: {
  className?: string;
  onClick: () => void;
  /** Escape hatch for rows that must not steal focus from a field. */
  onMouseDown?: MouseEventHandler<HTMLButtonElement>;
  /** Leading glyph. Turns the row into an icon + stacked-text layout. */
  icon?: ReactNode;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  const base = icon || trailing ? "list-row iconic" : "list-row";
  return (
    <button
      type="button"
      className={withBase(base, className)}
      onClick={onClick}
      onMouseDown={onMouseDown}
    >
      {icon ? <span className="row-icon">{icon}</span> : null}
      {icon || trailing ? <span className="row-main">{children}</span> : children}
      {trailing ? <span className="row-trail">{trailing}</span> : null}
    </button>
  );
}

/**
 * The top of every picker card: dismiss on the left, title centred, optional
 * confirm on the right. Identical geometry across pickers so the dismiss
 * control never moves between steps.
 */
export function PickerHeader({ title, onCancel, action }: {
  title: string;
  onCancel: () => void;
  action?: ReactNode;
}) {
  return (
    <header className="picker-head">
      <button type="button" className="ghost icon" aria-label="cancel" onClick={onCancel}>
        <CloseIcon />
      </button>
      <h2 className="line">{title}</h2>
      <span className="row">{action}</span>
    </header>
  );
}

/** A text input with a leading search glyph. */
export function SearchField({ value, placeholder, onChange }: {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="field search">
      <SearchIcon />
      <input
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

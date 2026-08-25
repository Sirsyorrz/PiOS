import type { FormEvent, ReactNode } from "react";

function withBase(base: string, className?: string): string {
  return className ? `${base} ${className}` : base;
}

/**
 * A full-screen step: one card, centered. Every pre-chat screen (pairing,
 * pickers) is one of these, so they stay visually identical by construction.
 */
export function ModalCard({ className, onSubmit, children }: {
  className?: string;
  onSubmit?: (event: FormEvent) => void;
  children: ReactNode;
}) {
  const cls = withBase("card", className);
  return (
    <div className="screen centered">
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
export function ListRowButton({ className, onClick, children }: {
  className?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className={withBase("list-row", className)} onClick={onClick}>
      {children}
    </button>
  );
}

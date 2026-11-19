// A table can be wider than a narrow window, or than a wide one zoomed far in. It scrolls
// sideways by itself, so that the page does not have to. It has a name and can be reached
// with the keyboard, so that it can be scrolled without a pointer.
import type { ReactNode } from 'react';

export function Wide({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="wide" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}

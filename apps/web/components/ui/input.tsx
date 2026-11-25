import * as React from 'react';
import { cn } from '../../lib/utils';

/*
 * shadcn's input with the plan's changes: the edge is the control-edge colour (--input, 3:1 or
 * more on the sheet and the desk), 32 px tall (40 where the pointer is coarse), the sheet colour
 * inside, and the focus is next.css's solid outline, not a soft ring. Text is 0.875rem (the
 * kit's 16 px on small screens is for iOS zoom; the app sets the size for every field itself).
 */
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'min-h-8 w-full min-w-0 rounded-md border border-input bg-card px-2.5 py-1 text-sm text-foreground transition-colors duration-(--pw-fast) file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive [@media(pointer:coarse)]:min-h-10',
        className,
      )}
      {...props}
    />
  );
}

export { Input };

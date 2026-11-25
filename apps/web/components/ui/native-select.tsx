import * as React from 'react';
import { ChevronDownIcon } from 'lucide-react';
import { cn } from '../../lib/utils';

/*
 * shadcn's native-select: a real <select> with the kit's look (PLAN.md section 7). Tests call
 * selectOption() on it and forms post without scripts, so it is never a Radix Select. The caret
 * is drawn over it and takes no pointer events. Styled like the input.
 */
function NativeSelect({
  className,
  size = 'default',
  wrapperClassName,
  ...props
}: Omit<React.ComponentProps<'select'>, 'size'> & {
  size?: 'sm' | 'default';
  /** For the box that holds the select and its caret (width, margins); `className` is the select's. */
  wrapperClassName?: string;
}) {
  return (
    <div
      className={cn(
        'group/native-select relative w-fit has-[select:disabled]:opacity-50',
        wrapperClassName,
      )}
      data-slot="native-select-wrapper"
      data-size={size}
    >
      <select
        data-slot="native-select"
        data-size={size}
        className={cn(
          'min-h-8 w-full min-w-0 appearance-none rounded-md border border-input bg-card py-1 pr-8 pl-2.5 text-sm text-foreground transition-colors duration-(--pw-fast) placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed aria-invalid:border-destructive data-[size=sm]:min-h-7 data-[size=sm]:py-0.5 [@media(pointer:coarse)]:min-h-10',
          className,
        )}
        {...props}
      />
      <ChevronDownIcon
        className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground select-none"
        aria-hidden="true"
        data-slot="native-select-icon"
      />
    </div>
  );
}

function NativeSelectOption({ ...props }: React.ComponentProps<'option'>) {
  return <option data-slot="native-select-option" {...props} />;
}

function NativeSelectOptGroup({ className, ...props }: React.ComponentProps<'optgroup'>) {
  return <optgroup data-slot="native-select-optgroup" className={cn(className)} {...props} />;
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption };

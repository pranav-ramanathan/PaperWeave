import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import { cn } from '../../lib/utils';

/*
 * shadcn's button (radix-nova) with the plan's changes (PLAN.md sections 3 and 4):
 *  - no soft focus ring: the solid 2 px outline of next.css (:focus-visible) shows, so no
 *    `outline-none` and no `ring-*` here; an invalid button is told by its edge, not a glow;
 *  - 28 px (sm) in toolbars, 32 px (default) in forms, never under 24 px; at least 40 px tall
 *    where the pointer is coarse;
 *  - hover that keeps the text above 4.5:1 (primary goes to 90 %, not 80 %), outline on the
 *    sheet colour, the quiet fills from the tokens.
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-clip-padding py-0.5 text-sm font-medium whitespace-nowrap transition-colors duration-(--pw-fast) ease-[cubic-bezier(0.2,0,0,1)] select-none active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive [@media(pointer:coarse)]:min-h-10 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        outline:
          'border-border bg-card text-foreground hover:bg-muted aria-expanded:bg-muted dark:border-input',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_8%)] aria-expanded:bg-secondary',
        ghost: 'hover:bg-muted hover:text-foreground aria-expanded:bg-muted',
        destructive: 'bg-transparent text-destructive hover:bg-destructive/10',
        link: 'text-primary underline underline-offset-4 hover:no-underline',
      },
      size: {
        default:
          'min-h-8 gap-1.5 px-3 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        xs: "min-h-6 gap-1 px-2 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "min-h-7 gap-1 px-2.5 text-[0.8125rem] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: 'min-h-9 gap-1.5 px-4 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3',
        icon: 'size-8',
        'icon-xs': "size-6 [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-7',
        'icon-lg': 'size-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : 'button';

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };

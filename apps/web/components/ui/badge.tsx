import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import { cn } from '../../lib/utils';

/*
 * shadcn's badge, as the status pill: a tinted wash with the kind's text colour and line (PLAN.md
 * section 3). The kinds are PaperWeave's own variants; colour is never the only sign, so a badge
 * always holds words (and, in the app, an icon).
 */
const badgeVariants = cva(
  'group/badge inline-flex min-h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-[550] whitespace-nowrap transition-colors [&>svg]:pointer-events-none [&>svg]:size-3 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground [a]:hover:bg-primary/90',
        secondary: 'bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80',
        destructive: 'bg-destructive/10 text-destructive [a]:hover:bg-destructive/20',
        outline: 'border-border text-foreground [a]:hover:bg-muted',
        ghost: 'hover:bg-muted hover:text-foreground',
        link: 'text-primary underline underline-offset-4 hover:no-underline',
        comment: 'border-comment-line/40 bg-comment-wash text-comment',
        proposal: 'border-proposal-line/40 bg-proposal-wash text-proposal',
        finding: 'border-finding-line/40 bg-finding-wash text-finding',
        model: 'border-model-line/40 bg-model-wash text-model',
        ok: 'border-ok-line/40 bg-ok-wash text-ok',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Badge({
  className,
  variant = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'span';

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };

'use client';
import { Tooltip as TooltipPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

// A tooltip is for an icon button: it says the name and the shortcut. It is not the button's
// accessible name (the button keeps today's words in its own text or `aria-label`), it is not a
// tab stop, and it opens on hover and on keyboard focus. It mounts when it opens, not before.
//
// Two differences from the shadcn original, on purpose:
//  - No <TooltipPrimitive.Portal>. The popup stays beside its trigger, inside <main
//    data-ui='next'>, so that the new look's rules (all scoped to that element) reach it and
//    the page keeps all its content in a landmark. Radix places it with position: fixed, so a
//    scrolling parent does not cut it off.
//  - No animation classes: motion is T48's, in app/next/motion.css, keyed on `data-state`.
// Radix adds no <style> element for this, so no nonce is needed (checked by the specimen test,
// which fails on any content-policy refusal).

/** Wrap a page's tooltips once, near the root of its <main>. */
function TooltipProvider({
  delayDuration = 300,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />;
}

function Tooltip(props: ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger(props: ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Content
      data-slot="tooltip-content"
      sideOffset={sideOffset}
      className={cn(
        'z-50 inline-flex w-fit max-w-xs items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs text-background shadow-lift',
        className,
      )}
      {...props}
    >
      {children}
    </TooltipPrimitive.Content>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };

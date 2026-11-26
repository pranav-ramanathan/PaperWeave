'use client';

import * as React from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { cn } from '../../lib/utils';

/*
 * shadcn's resizable (react-resizable-panels), with the plan's changes:
 *  - the handle is a hairline with a wider hit area, and no ring of its own: the solid 2 px outline
 *    of next.css (:focus-visible) shows, as on every other control;
 *  - it needs a name (`label`), because a separator that is a Tab stop is announced by it;
 *  - the library adds no <style> element (it adopts a style sheet), so no nonce is needed.
 */
function ResizablePanelGroup({ className, ...props }: React.ComponentProps<typeof Group>) {
  return (
    <Group
      data-slot="resizable-panel-group"
      className={cn('flex h-full w-full', className)}
      {...props}
    />
  );
}

function ResizablePanel({ ...props }: React.ComponentProps<typeof Panel>) {
  return <Panel data-slot="resizable-panel" {...props} />;
}

function ResizableHandle({
  className,
  label,
  ...props
}: Omit<React.ComponentProps<typeof Separator>, 'aria-label'> & { label: string }) {
  return (
    <Separator
      data-slot="resizable-handle"
      aria-label={label}
      className={cn(
        'relative flex w-px shrink-0 items-center justify-center bg-border after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2 data-[separator=active]:bg-ring data-[separator=hover]:bg-ring',
        className,
      )}
      {...props}
    />
  );
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };

'use client';

import * as React from 'react';
import { Button } from '../../../../components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../../../components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '../../../../components/ui/dropdown-menu';
import { Input } from '../../../../components/ui/input';
import { Label } from '../../../../components/ui/label';

/** A dialog with one named field and a menu, as the real pages will use them. */
export function Demo() {
  const field = React.useRef<HTMLInputElement>(null);
  const [open, setOpen] = React.useState(false);
  const [said, setSaid] = React.useState('Nothing yet.');
  const [spaced, setSpaced] = React.useState(true);

  return (
    <div className="mt-6 flex flex-wrap items-center gap-3">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="outline">Insert a caption</Button>
        </DialogTrigger>
        <DialogContent
          onOpenAutoFocus={(event) => {
            // Into the named field, not the first thing that can be focused.
            event.preventDefault();
            field.current?.focus();
          }}
        >
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              setSaid(`Caption: ${field.current?.value ?? ''}`);
              setOpen(false);
            }}
          >
            <DialogHeader>
              <DialogTitle>Insert a caption</DialogTitle>
              <DialogDescription>
                The words that go under the figure. Enter inserts, Escape cancels.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-1.5">
              <Label htmlFor="caption">Caption</Label>
              <Input id="caption" ref={field} autoComplete="off" />
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit">Insert</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">More</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>Insert</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => setSaid('Chose: Equation')}>
            Equation
            <DropdownMenuShortcut>Ctrl+M</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setSaid('Chose: Figure')}>Figure</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setSaid('Chose: Table')}>Table</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem checked={spaced} onCheckedChange={setSpaced}>
            Keep spacing
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setSaid('Chose: Delete')}>
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <p role="status" className="basis-full text-muted-foreground">
        {said} {spaced ? 'Spacing is kept.' : 'Spacing is not kept.'}
      </p>
    </div>
  );
}

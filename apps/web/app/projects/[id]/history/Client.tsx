'use client';

import { createContext, type ReactNode, type RefObject, useContext, useRef, useState } from 'react';
import { Button } from '../../../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../../components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../../../components/ui/dropdown-menu';
import { Input } from '../../../../components/ui/input';
import { Label } from '../../../../components/ui/label';
import { NativeSelect } from '../../../../components/ui/native-select';
import { Ellipsis } from '../../../../components/icon';
import Once from '../../../Once';

/** What the history page's pieces share: the revisions pressed "Compare". */
type Picked = { number: number; id: string };
const Ctx = createContext<{
  picked: Picked[];
  toggle: (p: Picked) => void;
} | null>(null);

type Option = { id: string; label: string };

/**
 * Holds which revisions are pressed "Compare". Two pressed fill the two lists of the form; a third
 * press replaces the older of the two pressed. Without scripts the buttons do nothing and the two
 * lists work as they are.
 */
export function CompareProvider({ children }: { children: ReactNode }) {
  const [picked, setPicked] = useState<Picked[]>([]);
  const toggle = (p: Picked) =>
    setPicked((now) =>
      now.some((n) => n.id === p.id) ? now.filter((n) => n.id !== p.id) : [...now.slice(-1), p],
    );
  return <Ctx.Provider value={{ picked, toggle }}>{children}</Ctx.Provider>;
}

/** A row's "Compare": a pressed button; two can be pressed. */
export function CompareToggle({ id, number }: { id: string; number: number }) {
  const ctx = useContext(Ctx)!;
  const on = ctx.picked.some((p) => p.id === id);
  return (
    <Button
      type="button"
      variant={on ? 'secondary' : 'ghost'}
      size="sm"
      aria-pressed={on}
      aria-label={`Compare revision ${number}`}
      onClick={() => ctx.toggle({ id, number })}
    >
      Compare
    </Button>
  );
}

/** The two lists, "Show the changes", and the line that says which two are pressed. */
export function ComparePicker({
  action,
  options,
  now,
  from,
  to,
}: {
  action: (form: FormData) => void | Promise<void>;
  options: Option[];
  /** The value that means "the paper as it is now", if it may be an end (for those who may make revisions). */
  now: string | null;
  from: string | undefined;
  to: string | undefined;
}) {
  const ctx = useContext(Ctx)!;
  const [chosen, setChosen] = useState({ from, to });
  const [seen, setSeen] = useState('');
  // Pressing two buttons sets both lists, the older one first. Done while drawing, once per change
  // of what is pressed, so the lists never lag behind the buttons.
  const key = ctx.picked.map((p) => p.id).join();
  if (key !== seen) {
    setSeen(key);
    if (ctx.picked.length === 2) {
      const [a, b] = [...ctx.picked].sort((x, y) => x.number - y.number);
      setChosen({ from: a.id, to: b.id });
    } else if (ctx.picked.length === 1) setChosen((c) => ({ ...c, from: ctx.picked[0].id }));
  }
  const numbers = ctx.picked.map((p) => p.number);
  const says =
    numbers.length === 2
      ? `Comparing revisions ${Math.min(...numbers)} and ${Math.max(...numbers)}.`
      : numbers.length === 1
        ? `Revision ${numbers[0]} is pressed. Press Compare on another revision, or choose below.`
        : '';
  return (
    <form action={action} className="history-picker">
      <p role="status" className="history-says">
        {says}
      </p>
      <div className="history-lists">
        <div>
          <Label htmlFor="history-from">Changes from</Label>
          <NativeSelect
            id="history-from"
            name="from"
            value={chosen.from ?? ''}
            onChange={(e) => setChosen((c) => ({ ...c, from: e.target.value }))}
            wrapperClassName="w-full"
          >
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div>
          <Label htmlFor="history-to">Changes up to</Label>
          <NativeSelect
            id="history-to"
            name="to"
            value={chosen.to ?? ''}
            onChange={(e) => setChosen((c) => ({ ...c, to: e.target.value }))}
            wrapperClassName="w-full"
          >
            {now && <option value={now}>The paper as it is now</option>}
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      <Once variant="outline">Show the changes</Once>
    </form>
  );
}

/** A run of automatic revisions: "Show" opens it in place. */
export function RunShow({ count, children }: { count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-label={`${open ? 'Hide' : 'Show'} the ${count} automatic revision${count === 1 ? '' : 's'}`}
        onClick={() => setOpen(!open)}
        className="history-run-toggle"
      >
        {open ? 'Hide' : 'Show'}
      </Button>
      {open && <ol className="history-run-rows">{children}</ol>}
    </>
  );
}

type Actions = {
  restore?: () => void | Promise<void>;
  name?: (form: FormData) => void | Promise<void>;
  build?: () => void | Promise<void>;
};

/**
 * What a revision's menu offers. The page gives each person only what they may do (restore and
 * naming for those who may make revisions, downloads for those who may export); the service
 * checks again when it is asked. Restore asks first, in a dialog that says what will happen.
 */
export function RowMenu({
  number,
  name,
  zip,
  pdf,
  actions,
}: {
  number: number;
  name: string | null;
  zip: string | null;
  pdf: string | null;
  actions: Actions;
}) {
  const [dialog, setDialog] = useState<'restore' | 'name' | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const build = useRef<HTMLFormElement>(null);
  if (!(actions.restore || actions.name || zip || pdf || actions.build)) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            ref={trigger}
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`More for revision ${number}`}
          >
            <Ellipsis aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {actions.restore && (
            <DropdownMenuItem onSelect={() => setDialog('restore')}>Restore</DropdownMenuItem>
          )}
          {actions.name && (
            <DropdownMenuItem onSelect={() => setDialog('name')}>Give it a name</DropdownMenuItem>
          )}
          {zip && (
            <>
              <DropdownMenuItem asChild>
                <a href={zip}>Download ZIP</a>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a href={`${zip}?manifest`}>Download ZIP with build details</a>
              </DropdownMenuItem>
            </>
          )}
          {pdf && (
            <DropdownMenuItem asChild>
              <a href={pdf}>Download PDF</a>
            </DropdownMenuItem>
          )}
          {actions.build && (
            <DropdownMenuItem onSelect={() => build.current?.requestSubmit()}>
              Build PDF
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {actions.build && <form ref={build} action={actions.build} hidden />}
      {actions.restore && (
        <RestoreDialog
          open={dialog === 'restore'}
          onOpenChange={(o) => setDialog(o ? 'restore' : null)}
          number={number}
          action={actions.restore}
          back={trigger}
        />
      )}
      {actions.name && (
        <Dialog open={dialog === 'name'} onOpenChange={(o) => setDialog(o ? 'name' : null)}>
          <DialogContent
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              trigger.current?.focus();
            }}
          >
            <form action={actions.name} className="grid gap-4">
              <DialogHeader>
                <DialogTitle>Give revision {number} a name</DialogTitle>
                <DialogDescription>
                  A named revision stays in the list, and is found again by its name.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-1.5">
                <Label htmlFor={`name-${number}`}>Name for revision {number}</Label>
                <Input
                  id={`name-${number}`}
                  name="name"
                  required
                  maxLength={200}
                  defaultValue={name ?? ''}
                  placeholder="Submitted to the workshop"
                />
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDialog(null)}>
                  Cancel
                </Button>
                <Once>Save name</Once>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

/** The confirmation: what a restore does, said once, and the button that does it. */
function RestoreDialog({
  open,
  onOpenChange,
  number,
  action,
  back,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  number: number;
  action: () => void | Promise<void>;
  back: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={(e) => {
          if (back.current) {
            e.preventDefault();
            back.current.focus();
          }
        }}
      >
        <form action={action} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Restore revision {number}?</DialogTitle>
            <DialogDescription>
              The paper goes back to revision {number}. The paper as it is now is kept as a revision
              first, so nothing is lost. Everyone who has the paper open is told.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Once>Restore revision {number}</Once>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "Restore revision N" under a comparison. */
export function RestoreButton({
  number,
  action,
}: {
  number: number;
  action: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button ref={button} type="button" variant="outline" onClick={() => setOpen(true)}>
        Restore revision {number}
      </Button>
      <RestoreDialog
        open={open}
        onOpenChange={setOpen}
        number={number}
        action={action}
        back={button}
      />
    </>
  );
}

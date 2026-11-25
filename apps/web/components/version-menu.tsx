'use client';

import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Check, ChevronDown, GitBranch } from './icon';

/** One place to switch to: "main" (the paper itself) or one of its versions. */
export type VersionChoice = {
  id: string;
  label: string;
  current: boolean;
  /** Where the entry leads, when it is not the same kind of page of that version (the editor). */
  href?: string;
};

/**
 * Which version of the paper this page is about, and the way to another: "main" first, then the
 * versions, each a plain link to the same kind of page of that version (`page` is the path after
 * the paper's address: "" for the paper page, "/history" for its history). The switcher is one
 * button (one tab stop) that opens a menu of links; the version in view is marked in words as well
 * as by the check mark, as everywhere. Only drawn when versions are turned on (the page decides).
 * Starting a version is on the history page, where the revisions are; the last entry leads there.
 */
export function VersionMenu({
  choices,
  page,
  paper,
}: {
  choices: VersionChoice[];
  page: '' | '/history';
  /** The address of "main", for the link to where versions are made. */
  paper: string;
}) {
  const here = choices.find((c) => c.current)?.label ?? 'main';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="max-w-[16rem]">
          <GitBranch aria-hidden="true" />
          Version: {here}
          <ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuLabel>Switch version</DropdownMenuLabel>
        {choices.map((c) => (
          <DropdownMenuItem key={c.id} asChild>
            <a
              href={c.href ?? `/projects/${c.id}${page}`}
              aria-current={c.current ? 'true' : undefined}
              className="flex w-full items-center gap-2"
            >
              <span className="inline-block size-4 shrink-0" aria-hidden="true">
                {c.current && <Check />}
              </span>
              {c.label}
              {c.current && <span className="sr-only"> (this one)</span>}
            </a>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href={`/projects/${paper}/history#versions`}>All versions</a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

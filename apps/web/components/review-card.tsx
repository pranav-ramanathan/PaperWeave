'use client';
// The review panel's frame and the look of its cards (PLAN.md section 4, "Review card"). The
// three lists (Proposals, Threads, Language) keep their own DOM and words; what this file gives
// them is class names (Tailwind utilities, which only match inside the new look), and, in the new
// look only, the panel's header: how many are open, and buttons that scroll to a list.
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { cn } from '../lib/utils';
import { buttonVariants } from './ui/button';
import { Icon, MessageSquare, Pencil, Sparkles, TriangleAlert } from './icon';
import { useLook } from './look';

export type CardKind = 'comment' | 'proposal' | 'model' | 'finding';
type Counted = 'comments' | 'changes' | 'language';

const Counts = createContext<((kind: Counted, n: number) => void) | null>(null);

/** Tell the panel how many are open in a list. Nothing happens outside the panel (old look). */
export function useReviewCount(kind: Counted, n: number | null) {
  const report = useContext(Counts);
  useEffect(() => {
    if (report && n !== null) report(kind, n);
  }, [report, kind, n]);
}

const EDGE: Record<CardKind, string> = {
  comment: 'border-l-comment-line',
  proposal: 'border-l-proposal-line',
  model: 'border-l-model-line',
  finding: 'border-l-finding-line',
};

/** The class names of an `article` card of this kind. */
export function cardClass(kind: CardKind) {
  return cn(
    'review-card grid gap-2 rounded-lg border border-l-4 bg-card p-3 text-sm text-card-foreground shadow-rest [overflow-wrap:anywhere]',
    EDGE[kind],
  );
}

/** The class names of a button in a card: one `primary` to a card, then `secondary`, then `quiet`. */
export function cardButton(variant: 'primary' | 'secondary' | 'quiet' = 'quiet') {
  return buttonVariants({
    size: 'sm',
    variant: variant === 'primary' ? 'default' : variant === 'secondary' ? 'outline' : 'ghost',
  });
}

/** Where a card's buttons go: a row that wraps. */
export const cardActions = 'review-actions flex flex-wrap items-center gap-1.5';
/** The quoted words of a comment or a finding, on the kind's wash. */
export function quoteClass(kind: 'comment' | 'finding') {
  return cn(
    'm-0 rounded-sm px-2 py-1 font-serif text-[0.9375rem] whitespace-pre-wrap [overflow-wrap:anywhere]',
    kind === 'comment' ? 'bg-comment-wash' : 'bg-finding-wash',
  );
}
/** A form in a card: fields as the forms of the new look have them. */
export const cardForm = 'review-form grid gap-2';
export const cardField =
  'block w-full rounded-md border border-input bg-card px-2.5 py-1.5 text-sm text-foreground';
export const cardLabel = 'grid gap-1 text-[0.8125rem] font-[550]';

const KIND_ICON = {
  comment: MessageSquare,
  proposal: Pencil,
  model: Sparkles,
  finding: TriangleAlert,
};
/**
 * The icon at the head of a card. The kind's words ("Comment", "Proposed change", "Model review",
 * "Spelling") come from the style sheet (review.css), so that they are drawn and not in the text
 * the tests and the screen reader read: the card's name already says what it is.
 */
export function CardKindMark({ kind }: { kind: CardKind }) {
  const look = useLook();
  if (look !== 'next') return null;
  return (
    <span className="review-kind" data-kind={kind} aria-hidden="true">
      <Icon icon={KIND_ICON[kind]} />
    </span>
  );
}

const FILTERS: { key: 'all' | Counted; label: string; id: string }[] = [
  { key: 'all', label: 'All', id: '' },
  { key: 'comments', label: 'Comments', id: 'comments' },
  { key: 'changes', label: 'Changes', id: 'proposals' },
  { key: 'language', label: 'Language', id: 'language' },
];

/**
 * The panel round the three lists. In the old look it is nothing (no element). In the new look it
 * is the column beside the text (or under it, narrow), with a header that counts and scrolls.
 */
export function ReviewPanel({ children }: { children: ReactNode }) {
  const look = useLook();
  const [counts, setCounts] = useState<Record<Counted, number | null>>({
    comments: null,
    changes: null,
    language: null,
  });
  const [shown, setShown] = useState<'all' | Counted>('all');
  const report = useCallback(
    (kind: Counted, n: number) => setCounts((c) => (c[kind] === n ? c : { ...c, [kind]: n })),
    [],
  );
  const total = useMemo(
    () => Object.values(counts).reduce<number>((a, n) => a + (n ?? 0), 0),
    [counts],
  );
  if (look !== 'next') return <>{children}</>;
  return (
    <Counts.Provider value={report}>
      <div className="review" data-review>
        <div className="review-head">
          <p className="review-title">
            <span>Review</span>
            <span className="review-total">{total} open in this file</span>
          </p>
          <div role="group" aria-label="Show" className="review-filter">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                aria-pressed={shown === f.key}
                onClick={() => {
                  setShown(f.key);
                  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
                  const target = f.id
                    ? document.getElementById(f.id)
                    : document.querySelector('[data-review] section');
                  target?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
                }}
              >
                {f.label}
                {f.key !== 'all' && counts[f.key] !== null && (
                  <span className="review-count">{counts[f.key]}</span>
                )}
              </button>
            ))}
          </div>
        </div>
        {children}
      </div>
    </Counts.Provider>
  );
}

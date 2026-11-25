/**
 * The mark: two threads crossing, one over and one under (solid blue, and dashed amber, the line
 * kinds of the review). Drawn for the plan; inline, so that it needs no request and follows the
 * tokens. Decorative: the word beside it names the service.
 */
export function Mark({ className = 'size-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false" fill="none">
      <path
        d="M3 7c5 0 4 10 9 10s4-10 9-10"
        stroke="var(--primary, #3b46c4)"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <path
        d="M3 17c5 0 4-10 9-10s4 10 9 10"
        stroke="var(--comment-line, #b86e00)"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeDasharray="7.5 4.5"
      />
    </svg>
  );
}

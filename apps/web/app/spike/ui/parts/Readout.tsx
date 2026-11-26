'use client';
import { useKit } from '../../../../components/kit';

/** What a component that has two drawings is told here: for the specimen's test. */
export default function Readout() {
  return (
    <p>
      The kit context says: <code data-testid="kit">{useKit() ? 'kit' : 'plain'}</code>
    </p>
  );
}

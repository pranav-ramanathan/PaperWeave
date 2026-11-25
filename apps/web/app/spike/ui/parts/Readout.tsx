'use client';
import { useLook } from '../../../../components/look';

/** What a component that branches on the look is told here: for the specimen's test. */
export default function Readout() {
  return (
    <p>
      The look context says: <code data-testid="look">{useLook()}</code>
    </p>
  );
}

'use client';
import type { ComponentProps } from 'react';
import { Textarea } from '../../../../../../components/ui/textarea';

/**
 * The text a person writes for a conflict. Typing in it chooses "Write it myself" (the radio whose
 * id is `radio`), so the words typed are the words used. Without scripts the radio is chosen by hand.
 */
export function OwnText({ radio, ...props }: ComponentProps<typeof Textarea> & { radio: string }) {
  return (
    <Textarea
      {...props}
      onInput={() => {
        const r = document.getElementById(radio);
        if (r instanceof HTMLInputElement) r.checked = true;
      }}
    />
  );
}

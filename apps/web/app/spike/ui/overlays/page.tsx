import { notFound } from 'next/navigation';
import { OverlayRoot } from '../../../../components/ui/overlay-root';
import { Demo } from './Demo';

export const metadata = { title: 'Specimen of dialogs and menus' };
export const dynamic = 'force-dynamic';

/**
 * The overlay primitives (components/ui/dialog.tsx, dropdown-menu.tsx) in the new look, behind
 * SPIKE like /spike/ui. What tests/e2e/specimen-overlays.spec.ts opens, types into and audits.
 */
export default async function Page() {
  if (process.env.SPIKE !== '1') notFound();
  return (
    <main data-ui="next" className="mx-auto max-w-4xl px-4 py-8">
      <OverlayRoot>
        <h1 className="font-heading text-3xl font-[650]">Specimen of dialogs and menus</h1>
        <p className="mt-2 max-w-prose text-muted-foreground">
          A dialog and a menu from Radix, in the new look. Both mount inside this page's main
          element, so the look's tokens reach them and they sit inside a landmark.
        </p>
        <Demo />
      </OverlayRoot>
    </main>
  );
}

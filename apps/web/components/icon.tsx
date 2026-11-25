import type { LucideIcon } from 'lucide-react';
import { cn } from '../lib/utils';

// Icons are lucide's, drawn as inline SVG (nothing is fetched; the policy allows no other host).
// Import the ones a component needs from here so that they are all drawn the same way, and so
// that this list is the one place to see which are in use.
export {
  Check,
  ChevronRight,
  CircleCheck,
  FileText,
  Folder,
  Info,
  Pencil,
  Sparkles,
  TriangleAlert,
  MessageSquare,
  Moon,
  Sun,
  X,
} from 'lucide-react';

/**
 * An icon beside words is decoration: hidden from screen readers, because the words say it. An
 * icon alone (an icon button) gets its name from the button, not from here, so that the
 * accessible name stays the text the tests read. Pass `label` only for an icon that stands
 * alone outside a button or link.
 */
export function Icon(props: { icon: LucideIcon; className?: string; label?: string }) {
  const { icon: Glyph, className, label } = props;
  return label ? (
    <Glyph className={cn('size-4 shrink-0', className)} role="img" aria-label={label} />
  ) : (
    <Glyph className={cn('size-4 shrink-0', className)} aria-hidden="true" />
  );
}

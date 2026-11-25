import { themeAction } from '../app/theme-action';
import { nextTheme, theme, type Theme } from '../lib/theme';
import { Monitor, Moon, Sun } from './icon';
import { buttonVariants } from './ui/button';

const words = (t: Theme | null) => (t === null ? 'the device’s own' : t);

/**
 * The control for the colours of the new look, for the right of the app bar. One button, so one
 * tab stop: each press goes on to the next of "the device's own", light, dark, and back. It is a
 * form with a server action, so it works before the page's scripts have started, and the page
 * comes back drawn in the choice (the layout puts it on <html>: lib/theme.ts). The icon is the
 * choice; the name says what is chosen and what a press does.
 */
export async function ThemeSwitch() {
  const now = await theme();
  const then = nextTheme(now);
  const Glyph = now === 'dark' ? Moon : now === 'light' ? Sun : Monitor;
  return (
    <form action={themeAction} aria-label="Theme" className="flex">
      <input type="hidden" name="theme" value={then ?? 'system'} />
      <button
        type="submit"
        className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
        aria-label={`Colours: ${words(now)}. Switch to ${words(then)}`}
      >
        <Glyph aria-hidden="true" />
      </button>
    </form>
  );
}

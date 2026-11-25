// The new look's three faces, self-hosted (SIL Open Font License 1.1, the licences are beside the
// files): Literata for the paper, headings and the mark's word; Atkinson Hyperlegible Next for
// tools and labels; Atkinson Hyperlegible Mono for source and file names. Variable fonts, Latin
// only, served from /_next/static/media (font-src 'self').
//
// Each one only declares a custom property (layout.tsx puts the classes on <html>); next.css reads
// them inside the [data-ui='next'] scope. The old look never names them, so no page in it changes.
// `preload: false`: no <link rel=preload> goes to a page that does not use them, until the look is
// the default.
import localFont from 'next/font/local';

export const literata = localFont({
  src: [
    { path: './literata-latin-wght-normal.woff2', style: 'normal', weight: '200 900' },
    { path: './literata-latin-wght-italic.woff2', style: 'italic', weight: '200 900' },
  ],
  variable: '--pw-font-serif',
  display: 'swap',
  preload: false,
  fallback: ['Iowan Old Style', 'Georgia', 'serif'],
});

export const atkinson = localFont({
  src: [
    {
      path: './atkinson-hyperlegible-next-latin-wght-normal.woff2',
      style: 'normal',
      weight: '200 800',
    },
  ],
  variable: '--pw-font-sans',
  display: 'swap',
  preload: false,
  fallback: ['system-ui', 'sans-serif'],
});

export const atkinsonMono = localFont({
  src: [
    {
      path: './atkinson-hyperlegible-mono-latin-wght-normal.woff2',
      style: 'normal',
      weight: '200 800',
    },
  ],
  variable: '--pw-font-mono',
  display: 'swap',
  preload: false,
  fallback: ['ui-monospace', 'Menlo', 'monospace'],
});

/** The three classes, for <html>. */
export const fontClasses = `${literata.variable} ${atkinson.variable} ${atkinsonMono.variable}`;

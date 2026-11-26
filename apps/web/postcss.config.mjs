// Tailwind v4 compiles app/next.css (the new look). Every selector that comes out of that one file
// is then prefixed with :where([data-ui='next']), the page's <main>: `:root`, `html` and `body` of
// the sheet stand for that element, so the tokens and the base rules are on it and not on the
// page's <html> and <body>, and `*` reaches only what is inside it. (Kept at T52, when the old
// look went: rendering is the same as before, which dropping it would have changed.) The other
// style sheets (functional.css, spike/spike.css, katex) are not touched by either plugin:
// Tailwind leaves a file without its directives alone, and the prefix is only applied to a file
// whose path includes `includeFiles`. Plugins are named, with plain options,
// because Turbopack reads this file as data. lib/nextcss.test.ts runs this same configuration.
export default {
  plugins: {
    '@tailwindcss/postcss': {},
    'postcss-prefix-selector': {
      prefix: ":where([data-ui='next'])",
      includeFiles: ['/app/next.css'],
    },
  },
};

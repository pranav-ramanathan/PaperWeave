// Tailwind v4 compiles app/next.css (the new look). Every selector that comes out of that one file
// is then prefixed with :where([data-ui='next']), so that it matches nothing on a page that is not
// in the new look. The other style sheets (legacy.css, functional.css, katex) are not touched by
// either plugin: Tailwind leaves a file without its directives alone, and the prefix is only
// applied to a file whose path includes `includeFiles`. Plugins are named, with plain options,
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

// The number this page's own scripts and style sheets carry (see proxy.ts). The editors add
// style sheets as they start, and those must carry it too or the page's policy refuses them.
// It is read from the property, not the attribute: browsers keep the attribute empty so that
// a style sheet cannot read it.
export const pageNonce = () =>
  document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')?.nonce ?? '';

// The number this page's own scripts and style sheets carry (see proxy.ts). The editors add
// style sheets as they start, and those must carry it too or the page's policy refuses them.
// It is read from the property, not the attribute: browsers keep the attribute empty so that
// a style sheet cannot read it.
// Read once, as the page's scripts start: a page asked for again (router.refresh) is drawn
// with a new number in this element, but the document keeps the policy it came with.
const first =
  typeof document === 'undefined'
    ? ''
    : (document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')?.nonce ?? '');
export const pageNonce = () => first;

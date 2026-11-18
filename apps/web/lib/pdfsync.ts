// The editor and the PDF beside it point at each other's places through here: the editor asks
// for a line to be shown in the PDF, and the PDF asks for a line to be shown in the editor.
export type SourcePlace = { fileId: string; path?: string; line: number };

const asked: { pdf?: (place: SourcePlace) => void; source?: (place: SourcePlace) => void } = {};

/** Show a line of a file in the PDF. Returns false when no PDF pane is listening. */
export const showInPdf = (place: SourcePlace) => (asked.pdf ? (asked.pdf(place), true) : false);
/** Show a line of a file in the editor. */
export const showInEditor = (place: SourcePlace) => asked.source?.(place);
/** Be the one who is asked. Returns how to stop. */
export function onShow(which: 'pdf' | 'source', fn: (place: SourcePlace) => void) {
  asked[which] = fn;
  return () => {
    if (asked[which] === fn) delete asked[which];
  };
}

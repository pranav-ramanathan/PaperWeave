// The editor and the PDF beside it point at each other's places through here: the editor asks
// for a line to be shown in the PDF, and the PDF asks for a line to be shown in the editor.
// `share` is how far along the line the place is (0 to 1); `word` is the word that was clicked in
// the PDF's text. The word is only ever passed between these two panes, never sent anywhere.
export type SourcePlace = {
  fileId: string;
  path?: string;
  line: number;
  share?: number;
  word?: string;
};

type Handlers = {
  pdf: (place: SourcePlace) => void;
  /** Says the line it put the place on, if it did. */
  source: (place: SourcePlace) => number | undefined | void;
};
const asked: { [K in keyof Handlers]?: Handlers[K] } = {};

/** Show a line of a file in the PDF. Returns false when no PDF pane is listening. */
export const showInPdf = (place: SourcePlace) => (asked.pdf ? (asked.pdf(place), true) : false);
/** Show a place of a file in the editor. Returns the line it was put on, if the editor says. */
export const showInEditor = (place: SourcePlace): number | undefined => {
  const used = asked.source?.(place);
  return typeof used === 'number' ? used : undefined;
};
/** Be the one who is asked. Returns how to stop. */
export function onShow<K extends keyof Handlers>(which: K, fn: Handlers[K]) {
  asked[which] = fn;
  return () => {
    if (asked[which] === fn) delete asked[which];
  };
}

/** A place meant for a file that is not open yet: kept for it to read once it has opened. */
let carried: SourcePlace | null = null;
export const carry = (place: SourcePlace) => void (carried = place);
/** What was carried for a file, once: it is forgotten as it is read. */
export function taken(fileId: string): SourcePlace | null {
  const place = carried?.fileId === fileId ? carried : null;
  carried = null;
  return place;
}

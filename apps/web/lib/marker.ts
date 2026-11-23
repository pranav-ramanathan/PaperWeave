/**
 * A line of LaTeX the visual view shows as one quiet line instead of a boxed block: a lone
 * \label, the \begin and \end lines of an environment whose body is prose, and the end of the
 * document. What they say is only for reading; the source is not touched.
 */
export type Marker = { kind: 'label' | 'begin' | 'end' | 'end-document'; text: string };

const LABEL = /^\\label\{([^{}]*)\}$/;
const BEGIN = /^\\begin\{([^{}\\%\n]+)\}/;
const END = /^\\end\{([^{}\\%\n]+)\}$/;
const TITLE = /^\[([^\\{}$%[\]]*)\]$/;

/** The key of a lone \label{key}, or null for anything else. */
export const labelKey = (src: string): string | null => LABEL.exec(src)?.[1] ?? null;

const bare = (env: string) => env.replace(/\*$/, '');

/**
 * `label` is what the parser called the block. `transparent` is the set of environments the
 * paper treats as prose. Returns null for everything that should stay a box.
 */
export function markerOf(
  src: string,
  label: string,
  transparent: ReadonlySet<string>,
): Marker | null {
  if (label === 'label') {
    const key = labelKey(src);
    return key === null ? null : { kind: 'label', text: key };
  }
  if (label === 'end document')
    return src.trim() === '\\end{document}'
      ? { kind: 'end-document', text: 'End of document' }
      : null;
  if (label === 'end') {
    const m = END.exec(src);
    return m && transparent.has(m[1])
      ? { kind: 'end', text: `End of ${bare(m[1]).toLowerCase()}` }
      : null;
  }
  const m = BEGIN.exec(src);
  if (!m || m[1] !== label || !transparent.has(label)) return null;
  const name = bare(label);
  let text = name.charAt(0).toUpperCase() + name.slice(1);
  const title = TITLE.exec(src.slice(m[0].length))?.[1].trim();
  if (title) text += ` (${title})`;
  return { kind: 'begin', text };
}

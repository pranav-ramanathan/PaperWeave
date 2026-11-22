// The visual document's shape. It is derived from LaTeX source and never stored.
import { getSchema, Mark, Node } from '@tiptap/core';

const src = () => ({ src: { default: '' } });
const atom = (name: string, inline: boolean, extra: Record<string, { default: string }> = {}) =>
  Node.create({
    name,
    group: inline ? 'inline' : 'block',
    inline,
    atom: true,
    selectable: true,
    addAttributes: () => ({ ...src(), ...extra }),
    // Copied as text, a formula or a citation keeps its LaTeX instead of vanishing.
    renderText: ({ node }) => node.attrs.src,
    renderHTML: ({ node }) => [
      inline ? 'span' : 'div',
      { class: `pw-atom pw-${name}`, 'data-label': node.attrs.label ?? null },
      node.attrs.src,
    ],
  });

const mark = (name: string, tag: string) => Mark.create({ name, renderHTML: () => [tag, 0] });

export const extensions = [
  Node.create({ name: 'doc', topNode: true, content: 'block*' }),
  Node.create({ name: 'text', group: 'inline' }),
  Node.create({
    name: 'paragraph',
    group: 'block',
    content: 'inline*',
    parseHTML: () => [{ tag: 'p' }],
    renderHTML: () => ['p', 0],
  }),
  Node.create({
    name: 'heading',
    group: 'block',
    content: 'inline*',
    addAttributes: () => ({ level: { default: 1 } }),
    renderHTML: ({ node }) => [`h${Math.min(node.attrs.level + 1, 6)}`, 0],
  }),
  Node.create({
    name: 'list',
    group: 'block',
    content: 'list_item+',
    addAttributes: () => ({ ordered: { default: false } }),
    renderHTML: ({ node }) => [node.attrs.ordered ? 'ol' : 'ul', 0],
  }),
  Node.create({ name: 'list_item', content: 'inline*', renderHTML: () => ['li', 0] }),
  atom('math_block', false),
  atom('raw_block', false, { label: { default: '' } }),
  atom('frozen', false, { message: { default: '' } }),
  atom('math_inline', true),
  atom('ref', true),
  atom('cite', true),
  atom('raw_inline', true),
  mark('emph', 'em'),
  mark('textbf', 'strong'),
  mark('textit', 'i'),
  mark('texttt', 'code'),
];

export const schema = getSchema(extensions);

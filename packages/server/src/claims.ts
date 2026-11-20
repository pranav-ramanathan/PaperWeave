// What a rewrite changes besides its wording. Two versions of a passage are compared for the
// things a claim is made of: its numbers and units, whether it is negated, which way an effect
// goes, how sure it is, what causes what, how much it covers, what it cites and whom it names.
// A difference in any of them is flagged, so that no edit changes a claim without saying so.
// These are rules over text, not a model: they err on the side of flagging.

export const CLAIM_RULES = 'claims-2';
export type ClaimChange = {
  kind:
    | 'number'
    | 'unit'
    | 'negation'
    | 'direction'
    | 'certainty'
    | 'causation'
    | 'scope'
    | 'novelty'
    | 'significance'
    | 'citation'
    | 'name';
  /** What the passage had of this kind, and what it has now. */
  was: string[];
  now: string[];
};

const words = (list: string) => list.trim().split(/\s+/);
const UNITS = new Set(
  words(`ms s sec secs second seconds min mins minute minutes h hr hrs hour hours day days week weeks
    month months year years ns us µs hz khz mhz ghz b kb mb gb tb kib mib gib bit bits byte bytes
    m cm mm km nm µm g kg mg µg l ml k v mv a ma w kw mw j kj n pa kpa mol mmol db % percent
    fold times x × pp point points samples participants subjects patients users nodes writers
    replicas runs trials edits requests`),
);
const NUMBER_WORDS = new Set(
  words(`zero one two three four five six seven eight nine ten eleven twelve twenty thirty forty
    fifty sixty seventy eighty ninety hundred thousand million billion half third quarter double
    twice thrice triple once dozen first second`),
);
const NEGATION = new Set(
  words(`not no never none neither nor without cannot fail fails failed lack lacks lacked absent
    unable impossible nothing nobody nowhere hardly barely`),
);
const UP = new Set(
  words(`increase increases increased increasing rise rises rose risen rising grow grows grew grown
    growing higher more greater larger bigger faster above improve improves improved improvement
    gain gains gained exceed exceeds exceeded outperform outperforms outperformed better up
    maximum longer stronger upper over superior boost boosts boosted high fast large big long
    strong good best positive after late`),
);
const DOWN = new Set(
  words(`decrease decreases decreased decreasing drop drops dropped fall falls fell fallen falling
    lower less fewer smaller slower below worse degrade degrades degraded reduce reduces reduced
    reduction decline declines declined down minimum shorter weaker under inferior loss
    lose loses lost low slow small little short weak bad worst negative before early`),
);
const HEDGE = new Set(
  words(`may might could can suggest suggests suggested appear appears appeared seem seems seemed
    likely unlikely possibly perhaps probably approximately roughly about around tend tends
    tended potentially believe believes hypothesise hypothesize hypothesised hypothesized
    indicate indicates indicated presumably apparently arguably somewhat partly partially
    preliminary tentative tentatively expect expected estimate estimated`),
);
const BOOST = new Set(
  words(`clearly always prove proves proved proven demonstrate demonstrates demonstrated certainly
    undoubtedly definitely guarantee guarantees guaranteed must obviously conclusively
    establish establishes established confirm confirms confirmed show shows showed shown
    unambiguously`),
);
const CAUSE = new Set(
  words(`cause causes caused causing because due therefore thus hence consequently leads led
    results resulted drives driven enables enabled produces produced yields yielded
    explains explained responsible effect effects induce induces induced trigger triggers
    triggered so since owing`),
);
const ASSOCIATE = new Set(
  words(`correlate correlates correlated correlation associate associated association linked
    related relationship coincide coincides coincided accompanies accompanied alongside
    co-occur co-occurs`),
);
const SCOPE = new Set(
  words(`all every each any always none most many some few several often sometimes rarely only
    generally general universal universally entire entirely whole majority minority typically
    usually occasionally both either certain various numerous`),
);
const NOVELTY = new Set(
  words(`first novel new unprecedented original state-of-the-art pioneering newly novelty
    innovative previously unknown unexplored`),
);
const SIGNIFICANCE = new Set(
  words(`significant significantly significance statistically insignificant p-value confidence
    marginal marginally substantial substantially negligible considerable considerably
    meaningful robust`),
);

/** LaTeX that changes how text looks, not what it says, taken off. */
const plain = (text: string) =>
  text
    .replace(/(?<!\\)%.*$/gm, '')
    .replace(/\\(emph|textbf|textit|textsc|textrm|text|mbox|mathrm)\{/g, '{')
    .replace(/\\[,;:! ]|~/g, ' ')
    .replace(/(\d) (\d{3})(?!\d)/g, '$1$2') // 1 000 is 1000
    .replace(/\\%/g, '%');

/** A number as one canonical string: ".5" is "0.5", "1,000" is "1000", a minus is a minus. */
const numeral = (raw: string) =>
  raw
    .replace('−', '-')
    .replace(/,(?=\d{3}\b)/g, '')
    .replace(/^([-+]?)\./, '$10.');
const NUMBER = String.raw`[-+−]?(?:\d+(?:[.,]\d+)*|(?<![\w.])\.\d+)`;

/**
 * Which way a word points. `most` and `least` do only in "at most", "at least"; "how long" asks
 * and does not say.
 */
function pointing(w: string, before: string | undefined): '+' | '-' | '' {
  if (before === 'how') return '';
  if (w === 'most' || w === 'least') return before !== 'at' ? '' : w === 'most' ? '+' : '-';
  return UP.has(w) ? '+' : DOWN.has(w) ? '-' : '';
}

const FUNCTION_WORDS = new Set(
  words(`by the a an of than to in on for is are was were be been being and or that this these its
    their our it at as with from`),
);
const BE = new Set(words('is are was were be been being'));

/**
 * Each number with the word before it, and each direction word or comparison sign with what it
 * bears on, so that "A beats B" and "B beats A", or "from 3 to 5" and "from 5 to 3", differ. With
 * `mask`, the numbers themselves are left out: they are reported as numbers already.
 */
function bound(source: string, mask = false): string[] {
  const text = plain(source).replace(
    /\\(\w*cite\w*|\w*ref|label)\*?(?:\[[^\]]*\])*\{[^}]*\}/g,
    ' ',
  );
  const toks = [
    ...text.matchAll(
      new RegExp(
        String.raw`\\[a-zA-Z]+|${NUMBER}|[\p{L}][\p{L}'’-]*|[<>≤≥]|<=|>=|[,.;:](?=\s|$)`,
        'gu',
      ),
    ),
  ].map((m) => m[0]);
  const isNum = (t: string) => /^[-+−]?\.?\d/.test(t);
  const low = toks.map((t) => (isNum(t) ? numeral(t) : t.toLowerCase()));
  const shown = (j: number) =>
    mask && (isNum(toks[j]) || NUMBER_WORDS.has(low[j])) ? 'N' : low[j];
  const count = (w: string) => low.filter((x) => x === w).length;
  const stop = (j: number) => /^[,.;:]$/.test(toks[j]);
  // What it bears on; if that is in the passage more than once ("method A", "method B"), the
  // token after it too.
  const next = (i: number) => {
    for (let j = i + 1; j < toks.length && !stop(j); j++)
      if (!FUNCTION_WORDS.has(low[j]))
        return count(low[j]) > 1 && j + 1 < toks.length && !stop(j + 1)
          ? `${shown(j)} ${shown(j + 1)}`
          : shown(j);
    return '';
  };
  const prev = (i: number) => {
    for (let j = i - 1; j >= 0 && !stop(j); j--)
      if (!FUNCTION_WORDS.has(low[j]))
        return j > 0 && count(low[j - 1]) > 1 ? `${shown(j - 1)} ${shown(j)}` : shown(j);
    return '';
  };
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    if (isNum(toks[i])) out.push(`${i > 0 ? shown(i - 1) : ''}#${shown(i)}`);
    const sign = /^[<>≤≥]|^\\(leq?|geq?|ll|gg)$/.test(toks[i]);
    const dir = sign ? toks[i] : pointing(low[i], low[i - 1]);
    if (!dir) continue;
    // Passive ("is outperformed by A"): what it bears on is what came before.
    const passive = low[i + 1] === 'by' && BE.has(low[i - 1] ?? '');
    out.push(`${dir}>${passive ? prev(i - 1) : next(i)}`);
  }
  return out.sort();
}

const WORD = /[\p{L}][\p{L}'’-]*/gu;
/** "unstable" negates "stable" only if "stable" is a word in the passage, in either version. */
const negatedBy = (w: string, vocabulary: Set<string>) => {
  const rest = /^(?:un|in|im|ir|il|dis|non)(.{4,})$/.exec(w)?.[1];
  return rest !== undefined && vocabulary.has(rest);
};

function facts(source: string, vocabulary: Set<string>) {
  const text = plain(source);
  const out: Record<ClaimChange['kind'], string[]> = {
    number: [],
    unit: [],
    negation: [],
    direction: [],
    certainty: [],
    causation: [],
    scope: [],
    novelty: [],
    significance: [],
    citation: [],
    name: [],
  };
  /** Words with a capital because a sentence starts with them. They may be names all the same. */
  const openers: string[] = [];
  // What is cited and what is referred to: by key, wherever it stands.
  for (const m of text.matchAll(/\\(\w*cite\w*|\w*ref)\*?(?:\[[^\]]*\])*\{([^}]*)\}/g))
    for (const key of m[2].split(',')) out.citation.push(`${m[1]}:${key.trim()}`);
  const prose = text.replace(/\\(\w*cite\w*|\w*ref|label)\*?(?:\[[^\]]*\])*\{[^}]*\}/g, ' ');
  // Numbers as written, with the unit that follows one. A percent is a percent however written.
  for (const m of prose.matchAll(
    new RegExp(String.raw`(?<![\w.])(${NUMBER}(?:[eE][-+]?\d+)?)\s*(%|[A-Za-zµ×]+)?`, 'g'),
  )) {
    out.number.push(numeral(m[1]));
    const unit = m[2]?.toLowerCase();
    if (unit && UNITS.has(unit)) out.unit.push(unit === 'percent' ? '%' : unit);
  }
  // Comparisons and bounds in formulas and prose: which way they point is part of the claim.
  for (const m of prose.matchAll(/\\(leq?|geq?|ll|gg|neq?|approx|sim)\b|[<>≤≥≠≈]|!=|<=|>=/g))
    out.direction.push(m[0]);
  const letters = prose.replace(/\\[a-zA-Z]+\*?/g, (m) => ' '.repeat(m.length));
  let first = true;
  let before: string | undefined;
  for (const m of letters.matchAll(/[\p{L}][\p{L}'’-]*/gu)) {
    const raw = m[0];
    const w = raw.toLowerCase().replace(/’/g, "'");
    if (NUMBER_WORDS.has(w)) out.number.push(w);
    if (NEGATION.has(w) || w.endsWith("n't") || w.startsWith('non-') || negatedBy(w, vocabulary))
      out.negation.push(w);
    const dir = pointing(w, before);
    if (dir) out.direction.push(dir);
    before = w;
    if (HEDGE.has(w)) out.certainty.push(`?${w}`);
    if (BOOST.has(w)) out.certainty.push(`!${w}`);
    if (CAUSE.has(w)) out.causation.push(`cause:${w}`);
    if (ASSOCIATE.has(w)) out.causation.push(`with:${w}`);
    if (SCOPE.has(w)) out.scope.push(w);
    if (NOVELTY.has(w)) out.novelty.push(w);
    if (SIGNIFICANCE.has(w)) out.significance.push(w);
    // A name: a capital inside a sentence, or all capitals anywhere (an acronym).
    const starts = first || /[.!?:]\s*$/.test(letters.slice(0, m.index));
    first = false;
    if (UNITS.has(w)) continue; // Hz, MB: not names
    if (/^\p{Lu}{2,}s?$/u.test(raw) || (/^\p{Lu}/u.test(raw) && !starts && raw.length > 1))
      out.name.push(raw);
    else if (/^\p{Lu}/u.test(raw)) openers.push(raw);
  }
  return { ...out, openers, bound: bound(source) };
}

/** The same things, however often and in whatever order. */
const same = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/**
 * What differs between two versions of a passage, of the kinds a claim is made of. Empty when a
 * rewrite keeps every number, name, citation and qualifying word it had.
 */
export function claimChanges(before: string, after: string): ClaimChange[] {
  const vocabulary = new Set(
    [...plain(before).matchAll(WORD), ...plain(after).matchAll(WORD)].map((m) =>
      m[0].toLowerCase().replace(/’/g, "'"),
    ),
  );
  const [
    { openers: wasOpeners, bound: wasBound, ...was },
    { openers: nowOpeners, bound: nowBound, ...now },
  ] = [facts(before, vocabulary), facts(after, vocabulary)];
  // A word that has moved to the start of a sentence, or away from it, is the same word.
  was.name = was.name.filter((n) => !nowOpeners.includes(n));
  now.name = now.name.filter((n) => !wasOpeners.includes(n));
  const out: ClaimChange[] = [];
  for (const kind of Object.keys(was) as ClaimChange['kind'][]) {
    if (kind === 'direction') {
      // A changed number is flagged as one; what the numbers are bound to is compared without them.
      const [a, b] = same(was.number, now.number)
        ? [wasBound, nowBound]
        : [bound(before, true), bound(after, true)];
      if (!same(a, b)) out.push({ kind, was: a, now: b });
      else if (!same(was.direction, now.direction))
        out.push({ kind, was: was.direction, now: now.direction });
    } else if (kind === 'certainty') {
      // How many hedges and how many boosters, not which: "shows" for "demonstrates" is no change.
      const classes = (l: string[]) => [
        l.filter((x) => x[0] === '?').length,
        l.filter((x) => x[0] === '!').length,
      ];
      if (classes(was.certainty).join() !== classes(now.certainty).join())
        out.push({ kind, was: was.certainty, now: now.certainty });
    } else if (!same(was[kind], now[kind])) out.push({ kind, was: was[kind], now: now[kind] });
  }
  return out;
}

/** A flag in words, for whoever decides on the edit. */
export function describeClaimChange(c: ClaimChange): string {
  const list = (items: string[]) =>
    items.length
      ? items
          .map((i) =>
            c.kind === 'direction'
              ? i
                  .replace(/^\+>/, 'up ')
                  .replace(/^->/, 'down ')
                  .replace(/^(.*?)>(.*)$/, '$1 $2')
                  .replace(/^(.*)#(.*)$/, '$1 $2')
                  .trim()
              : i.replace(/^[?!]|^cause:|^with:/, ''),
          )
          .join(', ')
      : 'none';
  const what = {
    number: 'The numbers differ',
    unit: 'The units differ',
    negation: 'A negation was added or removed',
    direction: 'Which way a comparison goes may have changed',
    certainty: 'It is more or less sure of itself',
    causation: 'What is said to cause what may have changed',
    scope: 'How much it covers may have changed',
    novelty: 'A claim of being new or first was added or removed',
    significance: 'A claim of significance was added or removed',
    citation: 'What it cites or refers to differs',
    name: 'The names in it differ',
  }[c.kind];
  return `${what}: ${list(c.was)} → ${list(c.now)}.`;
}

const REACH = 600;
const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);
/** A sentence ends just before `i`: a ".", "!" or "?" followed by whitespace, or the text ends. */
const endsBefore = (text: string, i: number) =>
  i > 0 && /[.!?]/.test(text[i - 1]) && (i === text.length || isSpace(text[i]));
/** A blank line starts at `i`: a newline, spaces if any, a newline. */
const blankFrom = (text: string, i: number) => /^\n[ \t]*\n/.test(text.slice(i, i + 200));
/** A blank line ends just before `i`. */
const blankBefore = (text: string, i: number) => {
  if (text[i - 1] !== '\n') return false;
  let j = i - 2;
  while (text[j] === ' ' || text[j] === '\t') j--;
  return text[j] === '\n';
};

/**
 * The sentences that the stretch `[from, to)` of `text` touches, as `[start, end)`: back to just
 * after the sentence end or blank line before it (or the start of the text), forward to just after
 * the sentence end after it (or the next blank line, or the end), and never more than 600
 * characters either side.
 */
export function sentenceAround(text: string, from: number, to: number): [number, number] {
  let start = Math.max(0, from - REACH);
  for (let i = from; i > start; i--)
    if (endsBefore(text, i) || blankBefore(text, i)) {
      start = i;
      break;
    }
  let end = Math.min(text.length, to + REACH);
  for (let i = to; i < end; i++)
    if (endsBefore(text, i) || blankFrom(text, i)) {
      end = i;
      break;
    }
  return [start, end];
}

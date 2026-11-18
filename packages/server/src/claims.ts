// What a rewrite changes besides its wording. Two versions of a passage are compared for the
// things a claim is made of: its numbers and units, whether it is negated, which way an effect
// goes, how sure it is, what causes what, how much it covers, what it cites and whom it names.
// A difference in any of them is flagged, so that no edit changes a claim without saying so.
// These are rules over text, not a model: they err on the side of flagging.

export const CLAIM_RULES = 'claims-1';
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
    maximum most longer stronger upper over superior boost boosts boosted`),
);
const DOWN = new Set(
  words(`decrease decreases decreased decreasing drop drops dropped fall falls fell fallen falling
    lower less fewer smaller slower below worse degrade degrades degraded reduce reduces reduced
    reduction decline declines declined down minimum least shorter weaker under inferior loss
    lose loses lost`),
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
    .replace(/\\%/g, '%');

function facts(source: string) {
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
  // Numbers as written, with the unit that follows one.
  for (const m of prose.matchAll(
    /(?<![\w.])([-+−]?\d+(?:[.,]\d+)*(?:[eE][-+]?\d+)?)\s*(%|[A-Za-zµ×]+)?/g,
  )) {
    out.number.push(m[1].replace('−', '-').replace(/,(?=\d{3}\b)/g, ''));
    if (m[2] && UNITS.has(m[2].toLowerCase())) out.unit.push(m[2].toLowerCase());
  }
  // Comparisons and bounds in formulas and prose: which way they point is part of the claim.
  for (const m of prose.matchAll(/\\(leq?|geq?|ll|gg|neq?|approx|sim)\b|[<>≤≥≠≈]|!=|<=|>=/g))
    out.direction.push(m[0]);
  const letters = prose.replace(/\\[a-zA-Z]+\*?/g, (m) => ' '.repeat(m.length));
  let first = true;
  for (const m of letters.matchAll(/[\p{L}][\p{L}'’-]*/gu)) {
    const raw = m[0];
    const w = raw.toLowerCase().replace(/’/g, "'");
    if (NUMBER_WORDS.has(w)) out.number.push(w);
    if (NEGATION.has(w) || w.endsWith("n't") || w.startsWith('non-')) out.negation.push(w);
    if (UP.has(w)) out.direction.push('+');
    if (DOWN.has(w)) out.direction.push('-');
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
    if (/^\p{Lu}{2,}s?$/u.test(raw) || (/^\p{Lu}/u.test(raw) && !starts && raw.length > 1))
      out.name.push(raw);
    else if (/^\p{Lu}/u.test(raw)) openers.push(raw);
  }
  return { ...out, openers };
}

/** The same things, however often and in whatever order. */
const same = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/**
 * What differs between two versions of a passage, of the kinds a claim is made of. Empty when a
 * rewrite keeps every number, name, citation and qualifying word it had.
 */
export function claimChanges(before: string, after: string): ClaimChange[] {
  const [{ openers: wasOpeners, ...was }, { openers: nowOpeners, ...now }] = [
    facts(before),
    facts(after),
  ];
  // A word that has moved to the start of a sentence, or away from it, is the same word.
  was.name = was.name.filter((n) => !nowOpeners.includes(n));
  now.name = now.name.filter((n) => !wasOpeners.includes(n));
  const out: ClaimChange[] = [];
  for (const kind of Object.keys(was) as ClaimChange['kind'][])
    if (!same(was[kind], now[kind])) out.push({ kind, was: was[kind], now: now[kind] });
  return out;
}

/** A flag in words, for whoever decides on the edit. */
export function describeClaimChange(c: ClaimChange): string {
  const list = (items: string[]) =>
    items.length ? items.map((i) => i.replace(/^[?!]|^cause:|^with:/, '')).join(', ') : 'none';
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

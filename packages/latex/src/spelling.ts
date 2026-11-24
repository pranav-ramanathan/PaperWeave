// Whether a paper is written in British or American English, from the paper itself: the words
// that are spelt one way in one and another way in the other, and else what its preamble asks
// babel or polyglossia for. Only words written in small letters count, so "Cold Spring Harbor"
// and "Centre National" say nothing. A word with -ize says nothing either: Oxford spelling is
// British. The patterns were tried on the checker's own word lists when they were written:
// of the 4,325 words they take, none is right in the other spelling.
// grammar-benchmark.sandbox.test.ts puts a sample to the checker each time.
import { prose } from './prose.ts';
import { DEFAULT_TRANSPARENT } from './parse.ts';

export type Spelling = 'en-GB' | 'en-US';

const PRE = '(?:un|dis|mis|re|multi)?';
const OR = `${PRE}(?:behavio|colo|favo|flavo|neighbo|tumo|hono|labo|harbo|rumo|vapo|endeavo|armo|odo|humo|rigo|vigo)`;
const OR_ENDS = '(?:s|ed|ing|able|ably|ful|hood|hoods|ite|ites|er|ers)?';
const AMERICAN = new RegExp(
  '^(?:' +
    [
      `${OR}r${OR_ENDS}|behavioral(?:ly)?`,
      '(?:re|epi|bary)?cent(?:er|ers|ered|ering)',
      '(?:re|mis)?analyz(?:e|es|ed|er|ers|ing)',
      '(?:un|mis|re)?label(?:ed|ing)',
      '(?:mis|re)?(?:model|travel|cancel|signal|channel|tunnel|fuel|dial|total|equal|rival|level)(?:ed|ing)',
      'fibers?|defenses?|offenses?|catalogs?|distills?|skeptic(?:al|s|ism)?|fulfill(?:s|ment)?',
      'aluminum|(?:kilo|centi|milli)meters?|liters?',
    ].join('|') +
    ')$',
);
const BRITISH = new RegExp(
  '^(?:' +
    [
      `${OR}ur${OR_ENDS}|behavioural(?:ly)?`,
      '(?:re|epi|bary)?cent(?:re|res|red|ring)',
      // Not "analyses": that is the plural everywhere.
      '(?:re|mis)?analys(?:e|ed|er|ers|ing)',
      // -isation, but for the one that is spelt so everywhere.
      '(?!improvis)[a-z]{3,}isations?',
      // -ise where it is a British -ize: normalise, summarise, optimise, organise. Not "arise",
      // "promise", "premises", "advertise", "exercise".
      '(?!un|rearis)[a-z]{2,}(?:[aeo]r|[ai]l|im|[a-z]n|tr)is(?:e|ed|ing|er|ers|able)',
      '(?:emphas|synthes|hypothes|critic|public|standard|quant|discret|digit|priorit|custom|random)is(?:e|ed|ing|er|ers)',
      'fibres?|defences?|offences?|licences?|programmes?|artefacts?|distils?|sceptic(?:al|s|ism)?',
      'aluminium|(?:kilo|centi|milli)?metres?|litres?',
    ].join('|') +
    ')$',
);

/** How many words of a text are spelt the American way, and how many the British way. */
export function spellingWords(text: string): { american: number; british: number } {
  let american = 0;
  let british = 0;
  // A word is letters and digits; one with a capital, an accent or a digit in it is skipped.
  for (const [word] of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    if (!/^[a-z]{4,}$/.test(word)) continue;
    if (AMERICAN.test(word)) american++;
    else if (BRITISH.test(word)) british++;
  }
  return { american, british };
}

const DECLARED: Record<string, Spelling> = {
  american: 'en-US',
  usenglish: 'en-US',
  usmax: 'en-US',
  us: 'en-US',
  british: 'en-GB',
  ukenglish: 'en-GB',
  uk: 'en-GB',
  australian: 'en-GB',
  newzealand: 'en-GB',
};
const OPTIONS =
  /\\(?:usepackage|RequirePackage|documentclass|PassOptionsToPackage|setdefaultlanguage|setmainlanguage)\s*\[([^\]]*)\]\s*\{([^{}]*)\}/g;

/**
 * What a preamble (comments taken out) asks for: an option of babel, of the class (babel reads
 * those too) or of polyglossia's main language. The last one named is the document's. Plain
 * `english` says nothing: it is what people write for both.
 */
export function declaredSpelling(preamble: string): Spelling | null {
  let found: Spelling | null = null;
  for (const m of preamble.matchAll(OPTIONS)) {
    if (!/^\\(?:documentclass|set)/.test(m[0]) && !/\bbabel\b/.test(m[2])) continue;
    const options = m[1].split(',').map((o) => o.trim().toLowerCase());
    const main = options.find((o) => /^(?:main|variant)\s*=/.test(o));
    // `us` and `uk` are polyglossia's short names for a variant, and no option of babel's.
    const named = (main ? [main.replace(/^.*=\s*/, '')] : options.filter((o) => o.length > 2)).map(
      (o) => DECLARED[o],
    );
    found = named.filter(Boolean).pop() ?? found;
  }
  return found;
}

/**
 * The spelling of a paper: of its body files (LaTeX source; only their prose is read) and the
 * preamble of its root. The words decide when more are spelt one way than the other; else the
 * preamble does; else nothing is known.
 */
export function spellingOf(
  sources: string[],
  preamble: string,
  transparent: ReadonlySet<string> = DEFAULT_TRANSPARENT,
): { language: Spelling; by: 'words' | 'preamble' } | null {
  let american = 0;
  let british = 0;
  for (const src of sources) {
    let text = '';
    for (const part of prose(src, transparent).annotation) if ('text' in part) text += part.text;
    const n = spellingWords(text);
    american += n.american;
    british += n.british;
  }
  if (american !== british)
    return { language: american > british ? 'en-US' : 'en-GB', by: 'words' };
  const declared = declaredSpelling(preamble);
  return declared ? { language: declared, by: 'preamble' } : null;
}

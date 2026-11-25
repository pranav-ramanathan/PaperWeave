import type { citationChecks, citationReport } from '@paperweave/server';
import Once from '../../../Once';
import { Wide } from '../../../Wide';
import Link from '../../../Go';
import Result from '../../../Result';
import { lookUpDoiAction, recordEvidenceAction, removeEvidenceAction } from '../../actions';

type Cited = Awaited<ReturnType<typeof citationReport>>;
type Checks = Awaited<ReturnType<typeof citationChecks>>;

const day = (iso: string) => iso.slice(0, 10);

/** What a DOI look-up or an evidence check reported: looked up, checked, removed. */
export function CheckNotices({
  looked,
  checked,
  unchecked,
  n,
}: {
  looked?: string;
  checked?: string;
  unchecked?: string;
  n?: string;
}) {
  return (
    <>
      {looked && (
        <Result>
          Looked up <code>{looked}</code>. The result is beside it below.
        </Result>
      )}
      {checked && (
        <Result>
          Recorded an evidence check for <code>{checked}</code>.
        </Result>
      )}
      {unchecked && (
        <Result key={n}>
          Removed a check of <code>{unchecked}</code>.
        </Result>
      )}
    </>
  );
}

/** The bibliography: what is missing or duplicated, and the table of checks. */
export function Bibliography({
  id,
  cited,
  checks,
  reviewer,
  allEntries,
  show,
}: {
  id: string;
  cited: Cited;
  checks: Checks;
  reviewer: boolean;
  /** Whether to list every entry, cited or not (`?entries=all`). */
  allEntries: boolean;
  show: boolean;
}) {
  // The bibliography's table is of what the paper cites, and of anything a check has been
  // recorded for. A .bib file kept for many papers holds thousands of entries this paper
  // never names; each row here has forms, and 2,000 of them made a page of 6 MB.
  const entryKeys = new Set<string>();
  const oneOfEach = cited.entries.filter((e) => !entryKeys.has(e.key) && entryKeys.add(e.key));
  const listedEntries = oneOfEach.filter(
    (e) => allEntries || e.cited || checks.lookups[e.key] || checks.evidence[e.key]?.length,
  );
  const unlisted = oneOfEach.length - listedEntries.length;
  return (
    <>
      {show && (
        <>
          <h2 id="bibliography" tabIndex={-1}>
            Bibliography
          </h2>
          <p>
            {cited.entries.length} {cited.entries.length === 1 ? 'entry' : 'entries'}.{' '}
            {cited.missing.length + cited.duplicates.length === 0
              ? 'Every citation has one.'
              : 'Some need attention:'}
          </p>
          {cited.missing.length + cited.duplicates.length > 0 && (
            <ul className="report attention">
              {cited.missing.map((m) => (
                <li key={`${m.fileId}:${m.line}:${m.key}`}>
                  <Link prefetch={false} href={`/projects/${id}/files/${m.fileId}`}>
                    <code>
                      {m.path}:{m.line}
                    </code>
                  </Link>{' '}
                  cites <code>{m.key}</code>, and no entry has that key. The PDF shows a question
                  mark there.
                </li>
              ))}
              {cited.duplicates.map((d) => (
                <li key={d.key}>
                  <code>{d.key}</code> is the key of {d.places.length} entries:{' '}
                  {d.places.map((p, i) => (
                    <span key={`${p.fileId}:${p.line}`}>
                      {i > 0 && ', '}
                      <Link prefetch={false} href={`/projects/${id}/files/${p.fileId}`}>
                        <code>
                          {p.path}:{p.line}
                        </code>
                      </Link>
                    </span>
                  ))}
                  . Only one of them is used.
                </li>
              ))}
            </ul>
          )}
          {cited.entries.length > 0 && (
            <>
              <p>
                Two different things can be checked about a citation, and they are recorded apart.
                Whether the <strong>entry is right</strong> is checked by looking its DOI up.
                Whether the source <strong>supports what the paper says</strong> is a person&apos;s
                judgement about one claim. One says nothing about the other.
              </p>
              {listedEntries.length > 0 && (
                <Wide label="Table of references">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Entry</th>
                        <th scope="col">Is the entry right?</th>
                        <th scope="col">Does it support the claim?</th>
                      </tr>
                    </thead>
                    <tbody>
                      {listedEntries.map((e) => {
                        const looked = checks.lookups[e.key];
                        const evidence = checks.evidence[e.key] ?? [];
                        const differing = looked?.comparison.filter((c) => !c.same) ?? [];
                        return (
                          <tr key={e.key}>
                            <th scope="row">
                              <code>{e.key}</code>
                              <br />
                              <span className="role">{e.description}</span>
                            </th>
                            <td>
                              {!e.doi && !looked && 'No DOI to look up.'}
                              {e.doi && !looked && 'Not looked up.'}
                              {looked && (
                                <>
                                  {looked.outcome === 'matches' && 'Matches the registry.'}
                                  {looked.outcome === 'not_found' &&
                                    'Crossref has no record of this DOI. It may be wrong, or registered elsewhere: arXiv and Zenodo DOIs, for example, are registered with DataCite.'}
                                  {looked.outcome === 'differs' && (
                                    <>
                                      Differs from the registry:
                                      <ul>
                                        {differing.map((c) => (
                                          <li key={c.field}>
                                            {c.field}: the entry says “{c.entry || 'nothing'}”, the
                                            registry “{c.registry || 'nothing'}”
                                          </li>
                                        ))}
                                      </ul>
                                    </>
                                  )}{' '}
                                  <span className="role">
                                    Looked up in{' '}
                                    {looked.source === 'crossref' ? 'Crossref' : looked.source} on{' '}
                                    {day(looked.lookedUpAt)}
                                    {looked.lookedUpBy ? ` by ${looked.lookedUpBy}` : ''}.
                                  </span>
                                  {looked.outOfDate && (
                                    <>
                                      {' '}
                                      <strong>The entry has been changed since.</strong>
                                    </>
                                  )}
                                </>
                              )}
                              {reviewer && e.doi && (
                                <form
                                  action={lookUpDoiAction.bind(null, id, e.key)}
                                  className="inline"
                                >
                                  {' '}
                                  <Once
                                    type="submit"
                                    aria-label={`${looked ? 'Look up again' : 'Look up DOI'} for ${e.key}`}
                                  >
                                    {looked ? 'Look up again' : 'Look up DOI'}
                                  </Once>
                                </form>
                              )}
                            </td>
                            <td>
                              {evidence.length === 0 && 'No claim checked.'}
                              <ul>
                                {evidence.map((c) => (
                                  <li key={c.id}>
                                    <strong>
                                      {c.verdict === 'supports'
                                        ? 'Supports'
                                        : c.verdict === 'partly'
                                          ? 'Partly supports'
                                          : 'Does not support'}
                                    </strong>
                                    : “{c.claim}”{c.note ? ` (${c.note})` : ''}{' '}
                                    <span className="role">
                                      {c.checkedBy ?? 'Someone'}, {day(c.checkedAt)}.
                                    </span>
                                    {!c.stillSaid && (
                                      <>
                                        {' '}
                                        <strong>The paper no longer says this.</strong>
                                      </>
                                    )}
                                    {c.mine && (
                                      <form
                                        action={removeEvidenceAction.bind(null, id, c.id)}
                                        className="inline"
                                      >
                                        {' '}
                                        <Once
                                          type="submit"
                                          aria-label={`Remove this check of ${e.key}`}
                                        >
                                          Remove
                                        </Once>
                                      </form>
                                    )}
                                  </li>
                                ))}
                              </ul>
                              {reviewer && (
                                <details>
                                  <summary>Record a check</summary>
                                  <form action={recordEvidenceAction.bind(null, id, e.key)}>
                                    <label>
                                      The claim, quoted from the paper
                                      <textarea
                                        name="claim"
                                        required
                                        maxLength={2000}
                                        rows={2}
                                        aria-label={`The claim that cites ${e.key}`}
                                      />
                                    </label>
                                    <label>
                                      The source
                                      <select name="verdict" defaultValue="supports">
                                        <option value="supports">supports it</option>
                                        <option value="partly">partly supports it</option>
                                        <option value="does_not_support">
                                          does not support it
                                        </option>
                                      </select>
                                    </label>
                                    <label>
                                      Note, such as where in the source
                                      <input name="note" maxLength={2000} />
                                    </label>
                                    <Once type="submit">Record</Once>
                                  </form>
                                </details>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </Wide>
              )}
              {unlisted > 0 && (
                <p>
                  {unlisted === 1
                    ? 'One more entry is in the paper’s .bib files and is not cited in it.'
                    : `${unlisted} more entries are in the paper’s .bib files and are not cited in it.`}{' '}
                  <Link prefetch={false} href={`/projects/${id}?entries=all#bibliography`}>
                    List them too
                  </Link>
                </p>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}

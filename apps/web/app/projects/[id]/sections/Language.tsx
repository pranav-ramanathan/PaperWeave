import type { languageSettings } from '@paperweave/server';
import Once from '../../../Once';
import Result from '../../../Result';
import { languageAction } from '../../actions';

type Language = Awaited<ReturnType<typeof languageSettings>>;

/** Spelling and the paper's own words. */
export function LanguageSection({
  id,
  language,
  canWrite,
  saved,
}: {
  id: string;
  language: Language;
  canWrite: boolean;
  /** The `language` parameter: set after the settings were saved. */
  saved?: string;
}) {
  return (
    <>
      <h2 id="language" tabIndex={-1}>
        Language
      </h2>
      {saved && <Result>Language settings saved.</Result>}
      <form action={languageAction.bind(null, id)} className="stack">
        {/* What this page showed, so that a save changes only what the person changed. */}
        <input type="hidden" name="shownLanguage" value={language.language} />
        <input type="hidden" name="shownGlossary" value={language.glossary.join(' ')} />
        {language.off.map((rule) => (
          <input key={rule} type="hidden" name="shownOff" value={rule} />
        ))}
        <label>
          Spelling
          <select name="language" defaultValue={language.language} disabled={!canWrite}>
            <option value="en-GB">British English</option>
            <option value="en-US">American English</option>
          </select>
        </label>
        <label>
          The paper&apos;s own words, which are not spelling mistakes
          <textarea
            name="glossary"
            rows={3}
            defaultValue={language.glossary.join('\n')}
            disabled={!canWrite}
            aria-describedby="glossary-help"
          />
        </label>
        <small id="glossary-help">Names, coinages and abbreviations, one to a line.</small>
        {language.off.length > 0 && (
          <fieldset>
            <legend>Rules switched off for this paper. Untick one to have it checked again.</legend>
            {language.off.map((rule) => (
              <label key={rule}>
                <input
                  type="checkbox"
                  name="off"
                  value={rule}
                  defaultChecked
                  disabled={!canWrite}
                />{' '}
                <code>{rule}</code>
              </label>
            ))}
          </fieldset>
        )}
        {canWrite && <Once type="submit">Save language settings</Once>}
      </form>
    </>
  );
}

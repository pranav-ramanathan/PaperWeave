import Once from '../../../Once';
import Result from '../../../Result';
import { modelProcessingAction } from '../../actions';

/** Whether passages of the paper may be sent to the model provider. */
export function Assistance({
  id,
  owner,
  allowModel,
  saved,
}: {
  id: string;
  owner: boolean;
  allowModel: boolean;
  /** The `assistance` parameter: set after the choice was saved. */
  saved?: string;
}) {
  return (
    <>
      <h2 id="assistance" tabIndex={-1}>
        Writing assistance
      </h2>
      {saved && <Result>Saved.</Result>}
      <p>
        A review by a language model reads the passage it is asked about and proposes changes, which
        are never made unless someone accepts them. For that, the passage is sent to the
        model&apos;s provider. Spelling and grammar checking is separate and sends nothing outside
        this service.
      </p>
      {owner ? (
        <form action={modelProcessingAction.bind(null, id)} className="stack">
          <label>
            <input type="checkbox" name="allow" defaultChecked={allowModel} /> Allow passages of
            this paper to be sent to the model provider when someone asks for a review
          </label>
          <Once type="submit">Save</Once>
        </form>
      ) : (
        <p>
          {allowModel
            ? 'The owner of this paper allows it.'
            : 'The owner of this paper has not allowed it, so nothing is sent.'}
        </p>
      )}
    </>
  );
}

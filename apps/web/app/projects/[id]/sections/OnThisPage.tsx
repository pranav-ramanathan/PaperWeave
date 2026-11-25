/** The list of links to the sections below; a link shows only when its section does. */
export function OnThisPage({
  showLabels,
  showBibliography,
  showData,
  showReview,
  owner,
}: {
  showLabels: boolean;
  showBibliography: boolean;
  showData: boolean;
  showReview: boolean;
  owner: boolean;
}) {
  return (
    <nav aria-label="On this page" className="onpage">
      <a href="#files">Files</a>
      {showLabels && <a href="#labels">Labels and references</a>}
      {showBibliography && <a href="#bibliography">Bibliography</a>}
      {showData && <a href="#data">Data</a>}
      {showReview && <a href="#review">Review</a>}
      <a href="#language">Language</a>
      <a href="#assistance">Writing assistance</a>
      <a href="#revisions">Revisions</a>
      <a href="#people">People</a>
      {owner && <a href="#invite">Invite someone</a>}
    </nav>
  );
}

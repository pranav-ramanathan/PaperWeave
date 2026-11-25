import {
  AppError,
  withScope,
  can,
  citationChecks,
  citationReport,
  firstSteps,
  importReport,
  labelReport,
  languageSettings,
  listCharts,
  heldDataReadBy,
  heldInRevisions,
  heldNow,
  listDatasets,
  listFiles,
  listInvitations,
  listMembers,
  listProposals,
  listRevisions,
  olderAutoRevisions,
  REVISIONS_SHOWN,
  listThreads,
  modelProcessing,
} from '@paperweave/server';
import { notFound } from 'next/navigation';
import { blobs, db, forTitle, paperOf, requireUser } from '../../../lib/server';
import { ui } from '../../../lib/ui';
import { Assistance } from './sections/Assistance';
import { Bibliography, CheckNotices } from './sections/Bibliography';
import { ChartRemovedNotice, Data, DescribedNotice } from './sections/Data';
import { Delete } from './sections/Delete';
import { FileNotices, Files, MovedNotice } from './sections/Files';
import { FirstSteps } from './sections/FirstSteps';
import { ErrorNotice, Header, Rename, RenamedNotice } from './sections/Header';
import { Invite, PendingInvitations } from './sections/Invite';
import { Labels, RelabelledNotice } from './sections/Labels';
import { LanguageSection } from './sections/Language';
import { OnThisPage } from './sections/OnThisPage';
import { HandOver, People } from './sections/People';
import { Review } from './sections/Review';
import { RevisionsSection } from './sections/Revisions';

export const dynamic = 'force-dynamic';

// The page reads what it shows here, in one place, and hands each section what it needs. A
// section is a file of its own in ./sections; none of them reads from the database.
async function Project({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    error?: string;
    invited?: string;
    cancelled?: string;
    removed?: string;
    unchecked?: string;
    n?: string;
    chartRemoved?: string;
    saved?: string;
    revision?: string;
    restored?: string;
    building?: string;
    added?: string;
    replaced?: string;
    deleted?: string;
    in?: string;
    root?: string;
    compiler?: string;
    renamed?: string;
    relabelled?: string;
    moved?: string;
    before?: string;
    entries?: string;
    looked?: string;
    described?: string;
    language?: string;
    assistance?: string;
    checked?: string;
    places?: string;
    owner?: string;
  }>;
}) {
  const { id } = await params;
  const user = await requireUser(`/projects/${id}`);
  // "Older revisions" asks for those below a number.
  const asked = Number((await searchParams).before);
  const olderThan = Number.isInteger(asked) && asked > 0 ? asked : undefined;
  const loaded = await Promise.all([
    paperOf(user.id, id),
    listMembers(db(), user.id, id),
    listFiles(db(), user.id, id),
    importReport(db(), user.id, id),
    listRevisions(db(), user.id, id, { autos: REVISIONS_SHOWN, before: olderThan }),
    labelReport(db(), blobs(), user.id, id),
    citationReport(db(), blobs(), user.id, id),
    citationChecks(db(), blobs(), user.id, id),
    listDatasets(db(), blobs(), user.id, id),
    listCharts(db(), blobs(), user.id, id),
    listThreads(db(), blobs(), user.id, id),
    listProposals(db(), blobs(), user.id, id),
    languageSettings(db(), user.id, id),
    modelProcessing(db(), user.id, id),
    firstSteps(db(), user.id, id),
  ]).catch((err) => {
    // Not a member, or no such paper: the two look the same from outside.
    if (err instanceof AppError && err.code === 'not_found') notFound();
    throw err;
  });
  const [
    project,
    members,
    files,
    report,
    revisions,
    labels,
    cited,
    checks,
    datasets,
    charts,
    threads,
    proposals,
    language,
    allowModel,
    steps,
  ] = loaded;
  // The oldest automatic revision shown, and how many there are before it.
  const heldAway = await heldNow(db(), user.id, id);
  const heldReads = new Set((await heldDataReadBy(db(), blobs(), user.id, id)).map((h) => h.path));
  const heldBy = await heldInRevisions(
    db(),
    user.id,
    id,
    revisions.map((r) => r.id),
  );
  const oldestAuto = revisions.findLast((r) => r.kind === 'auto')?.number;
  const olderAutos = oldestAuto ? await olderAutoRevisions(db(), user.id, id, oldestAuto) : 0;
  const pending = project.role === 'owner' ? await listInvitations(db(), user.id, id) : [];
  const openThreads = threads.filter((t) => t.status === 'open');
  const openProposals = proposals.filter((p) => p.status === 'open');
  const dataFiles = files.filter((f) => /\.(csv|tsv)$/i.test(f.path) && !f.readonly);
  const reviewer = can(project.role, 'comment.write');
  const query = await searchParams;
  const canWrite = can(project.role, 'file.write');
  const owner = project.role === 'owner';
  const showLabels = labels.labels.length > 0 || labels.undefined.length > 0;
  const showBibliography = cited.entries.length > 0 || cited.missing.length > 0;
  const showData = dataFiles.length > 0;
  const showReview = threads.length + proposals.length > 0;
  const look = await ui('paper');
  const next = look === 'next';
  const onThisPage = (
    <OnThisPage
      showLabels={showLabels}
      showBibliography={showBibliography}
      showData={showData}
      showReview={showReview}
      owner={owner}
    />
  );
  // Everything after the list of sections. In the new look the list sits beside it, in a grid of
  // two columns; in the old look both are the page's own children, as they were.
  const sections = (
    <>
      <ErrorNotice error={query.error} />
      <FileNotices
        added={query.added}
        replaced={query.replaced}
        deleted={query.deleted}
        revision={query.in}
        root={query.root}
        compiler={query.compiler}
      />
      <RenamedNotice renamed={query.renamed} name={project.name} />
      <Rename id={id} name={project.name} owner={owner} />

      <FirstSteps steps={steps} owner={owner} />
      <DescribedNotice described={query.described} />
      <CheckNotices
        looked={query.looked}
        checked={query.checked}
        unchecked={query.unchecked}
        n={query.n}
      />
      <ChartRemovedNotice chartRemoved={query.chartRemoved} />
      <MovedNotice moved={query.moved} places={query.places} />
      <RelabelledNotice relabelled={query.relabelled} places={query.places} />

      <Files id={id} project={project} files={files} report={report} heldAway={heldAway} />

      <Labels id={id} labels={labels} canWrite={canWrite} show={showLabels} />

      <Bibliography
        id={id}
        cited={cited}
        checks={checks}
        reviewer={reviewer}
        allEntries={query.entries === 'all'}
        show={showBibliography}
      />

      <Data
        id={id}
        dataFiles={dataFiles}
        datasets={datasets}
        charts={charts}
        heldReads={heldReads}
        canWrite={canWrite}
        show={showData}
      />

      <Review id={id} openThreads={openThreads} openProposals={openProposals} show={showReview} />

      <LanguageSection id={id} language={language} canWrite={canWrite} saved={query.language} />

      <Assistance id={id} owner={owner} allowModel={allowModel} saved={query.assistance} />

      <RevisionsSection
        id={id}
        project={project}
        revisions={revisions}
        heldBy={heldBy}
        olderAutos={olderAutos}
        oldestAuto={oldestAuto}
        olderThan={olderThan}
        saved={query.revision}
        restored={query.restored}
        building={query.building}
      />

      <People
        id={id}
        userId={user.id}
        members={members}
        owner={owner}
        saved={query.saved}
        cancelled={query.cancelled}
        removed={query.removed}
        newOwner={query.owner}
      />

      {owner && (
        <>
          <HandOver id={id} />
          <PendingInvitations id={id} pending={pending} />
          <Invite id={id} invited={query.invited} />
          <Delete id={id} />
        </>
      )}
    </>
  );
  return (
    <main className={next ? 'page paper' : 'page'} data-ui={look}>
      <Header name={project.name} role={project.role} next={next} />
      {next ? (
        <div className="paper-grid">
          {onThisPage}
          <div className="paper-flow">{sections}</div>
        </div>
      ) : (
        <>
          {onThisPage}
          {sections}
        </>
      )}
    </main>
  );
}

// What this page reads about the paper, it reads once.
/** The paper's name, from the read the page makes of it. */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await forTitle((userId) => paperOf(userId, id));
  return { title: project?.name ?? 'Paper' };
}

export default function Scoped(props: Parameters<typeof Project>[0]) {
  return withScope(() => Project(props));
}

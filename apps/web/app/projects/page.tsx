import { listProjects } from '@paperweave/server';
import { db, requireUser } from '../../lib/server';
import NextPapers from './NextPapers';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Papers' };

export default async function Projects({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; imported?: string; left?: string; deleted?: string }>;
}) {
  const user = await requireUser('/projects');
  const projects = await listProjects(db(), user.id);
  const { error, imported, left, deleted } = await searchParams;
  return (
    <NextPapers email={user.email} projects={projects} said={{ error, imported, left, deleted }} />
  );
}

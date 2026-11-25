// What the pages offer about versions, in one place. A version is a paper of its own that was begun
// at a revision of another (packages/server/src/versions.ts); everything here is behind the
// `VERSIONS` setting (docs/settings.md), off by default, and with it off no page shows a trace.
import { can, versionsEnabled, type Role, type Version } from '@paperweave/server';

/** Whether versions are turned on. */
export const versionsOn = () => versionsEnabled();

/**
 * What a role may do with versions, as the service decides it (`authorize` in the service answers
 * again for every action): everyone on the paper sees them; the owner and editors start and rename;
 * only the owner deletes.
 */
export function versionPowers(role: Role | null | undefined) {
  return {
    see: !!role && can(role, 'project.read'),
    start: !!role && can(role, 'revision.write'),
    rename: !!role && can(role, 'revision.write'),
    // Merging rewrites text, as a restore does: the owner and editors, as starting a version.
    merge: !!role && can(role, 'revision.write'),
    delete: !!role && can(role, 'project.settings'),
  };
}

/** One entry of a version switcher: "main" first, then the versions, oldest first. */
export type Switch = { id: string; label: string; current: boolean };

/** The switcher's entries for the paper `here` (a paper or one of its versions). */
export function switcherOf(main: string, versions: Version[], here: string): Switch[] {
  return [
    { id: main, label: 'main', current: here === main },
    ...versions.map((v) => ({ id: v.id, label: v.name, current: here === v.id })),
  ];
}

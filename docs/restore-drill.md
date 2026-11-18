# Restore drill

What is backed up, how to bring it back, and what a drill has shown.

## What there is to lose

- **The database** (PostgreSQL): papers, who is on them, every file's edit log, revisions,
  builds, threads, proposals, settings. This is the half that is ours to back up.
- **The object store**: the bytes of uploaded files, of every revision's files, and of build
  outputs, each named by its SHA-256. Objects are only ever added, never changed, so any later
  copy of the store holds everything an earlier database needs. Backing it up is for whoever
  hosts it.

## The procedure

Back up:

```bash
infra/backup.sh <database> backup.dump
```

Restore into a database that exists and is empty, then check the object store against it:

```bash
infra/restore.sh backup.dump <database>
```

```bash
pnpm --filter @paperweave/server check-blobs
```

`check-blobs` fetches every object the database refers to and checks it against its name. It
prints what is missing or corrupt and exits non-zero if anything is. The two scripts use the
Postgres of `infra/compose.yaml`; against a real server, run `pg_dump --format custom
--no-owner` and `pg_restore --no-owner --exit-on-error` the same way.

## What the drill shows

`apps/workers/src/restore-drill.sandbox.test.ts` runs in CI. It makes a real paper with a
history (the six-file IEEE fixture: imported, edited, saved as a revision, built, commented
on, changed by an accepted proposal, and edited again since the last revision), backs the
database up with `infra/backup.sh`, restores it with `infra/restore.sh` into a database that
has never held anything, and asks the restored copy for everything:

- the list of files with their digests, and the list of revisions;
- the saved revision as a ZIP, byte for byte, and the PDF that was built from it;
- the thread and where it stands, the proposal and what it changed;
- the text as it stands now, including what was typed after the last revision.

All of it equals what the original gave. The restored copy then takes a new edit and a new
revision, numbered on from the last. `check-blobs` finds nothing missing, and, given a store
with one object taken away, names that object.

## What it does not show

- **Losing the object store.** The drill restores the database against the same store. A
  store restored from its own backup is not exercised: that depends on where it is hosted,
  which is not decided.
- **How much is lost.** A dump is of one moment. Edits acknowledged after it are gone unless
  the database also keeps a write-ahead log to replay, which is a setting of the host. No
  recovery point or recovery time has been measured.
- **People connected at the time.** Someone with a file open while the database is replaced
  will reconnect to an older history. Their unsent edits merge; edits the old database had
  acknowledged after the dump are in their browser and are sent again. That has not been
  drilled.
- **Size.** One paper. Not a database of thousands, and not how long a dump or restore takes.

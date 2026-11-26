'use client';
import { Fragment, useEffect, useState } from 'react';
import Link from '../../../../Go';
import { FileText, Folder } from '../../../../../components/icon';
import { onFiles, type PaperFile } from '../../../../../lib/paperfiles';

/**
 * The paper's files: as the page was made with them, until the list has been asked for again
 * (see lib/paperfiles). A page made later comes with a list of its own, which then counts.
 */
export function useFiles(projectId: string, made: PaperFile[]) {
  const [got, setGot] = useState<{ made: PaperFile[]; files: PaperFile[] } | null>(null);
  useEffect(() => onFiles(projectId, (files) => setGot({ made, files })), [projectId, made]);
  return got?.made === made ? got.files : made;
}

/** The name of the file now open, as the list has it (a rename shows here too). */
export function FileName(props: {
  projectId: string;
  fileId: string;
  files: PaperFile[];
  path: string;
}) {
  const files = useFiles(props.projectId, props.files);
  return <>{files.find((f) => f.id === props.fileId)?.path ?? props.path}</>;
}

/**
 * The list of the paper's files beside the editor. It follows files added, removed and renamed.
 * `root` is the path of the root file.
 */
export default function Files(props: {
  projectId: string;
  fileId: string;
  files: PaperFile[];
  root?: string;
}) {
  const files = useFiles(props.projectId, props.files);
  return <Tree {...props} files={files} />;
}

/**
 * The tree. The links are in order, each with its whole path as its text
 * (the folders it sits in are said by a hidden prefix and drawn as a heading row above), so a
 * link's name is its path. A folder row is shown when the folder differs from
 * the one the file before it sat in; it is not read out, the paths already say it.
 */
function Tree(props: { projectId: string; fileId: string; files: PaperFile[]; root?: string }) {
  let before: string[] = [];
  return (
    <nav aria-label="Files" className="files-tree">
      <h2>Files</h2>
      <ul>
        {props.files.map((f) => {
          const parts = f.path.split('/');
          const name = parts.pop() ?? f.path;
          const rows: { folder: string; depth: number }[] = [];
          let same = true;
          parts.forEach((dir, depth) => {
            same = same && before[depth] === dir;
            if (!same) rows.push({ folder: dir, depth });
          });
          before = parts;
          const current = f.id === props.fileId;
          const inside = (
            <>
              <FileText aria-hidden="true" className="files-icon" />
              {parts.length > 0 && <span className="sr-only">{`${parts.join('/')}/`}</span>}
              <span className="files-name">{name}</span>
            </>
          );
          return (
            <Fragment key={f.id}>
              {rows.map((r) => (
                <li
                  key={`${r.depth}/${r.folder}`}
                  aria-hidden="true"
                  className="files-folder"
                  style={{ marginInlineStart: `${r.depth * 0.875}rem` }}
                >
                  <Folder className="files-icon" />
                  {r.folder}
                </li>
              ))}
              <li
                className="files-file"
                style={{ marginInlineStart: `${parts.length * 0.875}rem` }}
              >
                {f.readonly ? (
                  <span title="Cannot be edited as text" className="files-entry">
                    {inside}
                  </span>
                ) : (
                  <Link
                    prefetch={false}
                    href={`/projects/${props.projectId}/files/${f.id}`}
                    aria-current={current ? 'page' : undefined}
                    className="files-entry"
                    // The hidden folder prefix below keeps the link's text its whole path; this
                    // keeps its name that too (a hidden box would put a space inside it).
                    aria-label={f.path}
                  >
                    {inside}
                  </Link>
                )}
                {props.root === f.path && <span className="files-root">root</span>}
              </li>
            </Fragment>
          );
        })}
      </ul>
    </nav>
  );
}

'use client';
import { useEffect, useState } from 'react';
import Link from '../../../../Go';
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

/** The list of the paper's files beside the editor. It follows files added, removed and renamed. */
export default function Files(props: { projectId: string; fileId: string; files: PaperFile[] }) {
  const files = useFiles(props.projectId, props.files);
  return (
    <nav aria-label="Files">
      <ul>
        {files.map((f) => (
          <li key={f.id}>
            {f.readonly ? (
              <span title="Cannot be edited as text">{f.path}</span>
            ) : (
              <Link
                prefetch={false}
                href={`/projects/${props.projectId}/files/${f.id}`}
                aria-current={f.id === props.fileId ? 'page' : undefined}
              >
                {f.path}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

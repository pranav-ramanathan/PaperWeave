'use client';
import { useEffect } from 'react';

/** A file dropped on a page is not opened in its place: the page, and what is on it, stays. */
export default function Dropped() {
  useEffect(() => {
    const keep = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return; // dragged text is not ours
      // A field for choosing a file takes a dropped one itself.
      if (e.target instanceof HTMLInputElement && e.target.type === 'file') return;
      // Whoever has already taken it (the visual view) keeps its own cursor.
      if (e.type === 'dragover' && !e.defaultPrevented) e.dataTransfer.dropEffect = 'none';
      e.preventDefault();
    };
    window.addEventListener('dragover', keep);
    window.addEventListener('drop', keep);
    return () => {
      window.removeEventListener('dragover', keep);
      window.removeEventListener('drop', keep);
    };
  }, []);
  return null;
}

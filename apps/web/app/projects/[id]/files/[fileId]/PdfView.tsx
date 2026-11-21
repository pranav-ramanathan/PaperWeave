'use client';

import { useEffect, useRef, useState } from 'react';

/** A place on a page, in PDF points from the page's top-left corner. */
export type Mark = { page: number; x: number; y: number; height: number };

/**
 * A PDF drawn page by page, so that a place on a page can be pointed at and a double-click on a
 * page says where it was. A page is drawn when it comes near the window, with its words laid
 * over the picture of it: they can be selected, and a screen reader reads them.
 */
export default function PdfView(props: {
  src: string;
  mark: Mark | null;
  /** `nearest`: the place is a guess at the middle of the pane, so the nearest thing will do. */
  onPick(page: number, x: number, y: number, nearest?: boolean): void;
  /** Set to a way of picking the place in the middle of what the pane is showing. */
  middle: { current: () => void };
}) {
  const { src, mark } = props;
  const host = useRef<HTMLDivElement>(null);
  const [problem, setProblem] = useState(false);
  const [drawn, setDrawn] = useState('');
  const pick = useRef(props.onPick);
  pick.current = props.onPick;

  useEffect(() => {
    let stop = false;
    let close = () => {};
    setProblem(false);
    void (async () => {
      const pdfjs = await import('pdfjs-dist');
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url,
      ).toString();
      const task = pdfjs.getDocument({ url: src });
      close = () => void task.destroy();
      const doc = await task.promise;
      if (stop || !host.current) return;
      // The new pages are made beside the old and swapped in whole, so that a rebuilt PDF
      // appears where the old one was scrolled to.
      const pages = document.createElement('div');
      // Only the pages near the window keep their picture: a page is a large canvas, and a long
      // paper read through would otherwise hold every one of them.
      const near = new Set<HTMLElement>();
      const busy = new Set<HTMLElement>();
      const watch = new IntersectionObserver(
        (seen) => {
          for (const s of seen) {
            const holder = s.target as HTMLElement;
            if (s.isIntersecting) near.add(holder);
            else near.delete(holder);
            void settle(holder);
          }
        },
        { root: host.current, rootMargin: '100% 0px' },
      );
      const release = (holder: HTMLElement) => {
        const canvas = holder.querySelector('canvas')!;
        canvas.width = canvas.height = 0;
        delete holder.dataset.drawn;
      };
      // One page at a time is drawn or released: PDF.js refuses a second render() on a canvas
      // that is still being drawn, as happens when a page leaves and comes back.
      const settle = async (holder: HTMLElement) => {
        if (busy.has(holder)) return;
        busy.add(holder);
        try {
          const drawn = holder.dataset.drawn === 'yes';
          if (near.has(holder) && !drawn) await draw(holder);
          else if (!near.has(holder) && drawn) release(holder);
        } finally {
          busy.delete(holder);
        }
        if (!stop && near.has(holder) !== (holder.dataset.drawn === 'yes')) void settle(holder);
      };
      const draw = async (holder: HTMLElement) => {
        const page = await doc.getPage(Number(holder.dataset.page));
        if (stop) return;
        const canvas = holder.querySelector('canvas')!;
        // Sharp on dense screens, but not more than twice the size: a page is a large picture.
        const scale =
          (holder.clientWidth / page.getViewport({ scale: 1 }).width) *
          Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvas, viewport }).promise.catch(() => {});
        page.cleanup();
        // The page's words, invisible, each where the picture shows it. They stay when the
        // picture is released, so that what was read can still be selected and read aloud.
        if (holder.querySelector('.textLayer')) {
          holder.dataset.drawn = 'yes';
          return;
        }
        const size = holder.clientWidth / page.getViewport({ scale: 1 }).width;
        const words = document.createElement('div');
        words.className = 'textLayer';
        words.style.setProperty('--total-scale-factor', String(size));
        holder.append(words);
        await new pdfjs.TextLayer({
          textContentSource: page.streamTextContent(),
          container: words,
          viewport: page.getViewport({ scale: size }),
        })
          .render()
          .catch(() => {});
        holder.dataset.drawn = 'yes';
      };
      for (let n = 1; n <= doc.numPages; n++) {
        const size = (await doc.getPage(n)).getViewport({ scale: 1 });
        const holder = document.createElement('div');
        holder.className = 'pdf-page';
        holder.dataset.page = String(n);
        holder.dataset.width = String(size.width);
        holder.dataset.height = String(size.height);
        holder.style.aspectRatio = `${size.width} / ${size.height}`;
        holder.setAttribute('role', 'group');
        holder.setAttribute('aria-label', `Page ${n} of ${doc.numPages}`);
        holder.append(document.createElement('canvas'));
        holder.addEventListener('dblclick', (e) => {
          const box = holder.getBoundingClientRect();
          pick.current(
            n,
            ((e.clientX - box.left) / box.width) * size.width,
            ((e.clientY - box.top) / box.height) * size.height,
          );
        });
        pages.append(holder);
      }
      if (stop) return;
      host.current.replaceChildren(pages);
      for (const holder of pages.children) watch.observe(holder);
      setDrawn(src);
      const destroy = close;
      close = () => {
        watch.disconnect();
        destroy();
      };
    })().catch(() => !stop && setProblem(true));
    return () => {
      stop = true;
      close();
    };
  }, [src]);

  // For going from the PDF to the text without a pointer: the pane is scrolled with the
  // keyboard until the passage is in the middle of it, and this picks what is there.
  props.middle.current = () => {
    const el = host.current;
    const pages = [...(el?.querySelectorAll<HTMLElement>('.pdf-page') ?? [])];
    if (!el || !pages.length) return;
    const at = el.scrollTop + el.clientHeight / 2;
    // The page the middle falls on, or the nearest if it falls between two.
    const far = (p: HTMLElement) =>
      at < p.offsetTop ? p.offsetTop - at : Math.max(0, at - p.offsetTop - p.offsetHeight);
    const holder = pages.reduce((best, p) => (far(p) < far(best) ? p : best));
    const [width, height] = [Number(holder.dataset.width), Number(holder.dataset.height)];
    const down = Math.min(1, Math.max(0, (at - holder.offsetTop) / holder.offsetHeight));
    pick.current(Number(holder.dataset.page), width / 2, down * height, true);
  };

  // Point at the place: bring its page into view and lay a band over the line.
  useEffect(() => {
    const el = host.current;
    if (!el || !mark || drawn !== src) return;
    const holder = el.querySelector<HTMLElement>(`[data-page="${mark.page}"]`);
    if (!holder) return;
    const height = Number(holder.dataset.height);
    const band = document.createElement('div');
    band.className = 'pdf-mark';
    band.dataset.page = String(mark.page);
    band.style.top = `${(100 * mark.y) / height}%`;
    band.style.height = `${(100 * mark.height) / height}%`;
    holder.append(band);
    const top = holder.offsetTop + (holder.offsetHeight * mark.y) / height;
    el.scrollTo({ top: Math.max(0, top - el.clientHeight / 3) });
    return () => band.remove();
  }, [mark, drawn, src]);

  return (
    <>
      {problem && <p role="alert">The PDF could not be shown here. Open it with the link above.</p>}
      {/* Reachable from the keyboard, so that it can be scrolled and read without a pointer. */}
      <div className="pdf" ref={host} tabIndex={0} role="region" aria-label="Pages of the PDF" />
    </>
  );
}

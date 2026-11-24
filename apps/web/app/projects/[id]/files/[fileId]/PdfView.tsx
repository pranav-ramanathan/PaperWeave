'use client';

import { useEffect, useRef, useState } from 'react';
import { intoWindow } from '../../../../../lib/pdfsync';
import { wordIn, wordSpan } from '../../../../../lib/pdfword';

/**
 * A place on a page, in PDF points from the page's top-left corner. `left` and `width` are the
 * line of text's own extent, when known: a band is then only as wide as that, not the page.
 */
export type Mark = {
  page: number;
  x: number;
  y: number;
  height: number;
  left?: number;
  width?: number;
};

/** The sizes the pages can be shown at, as a share of the pane's width. */
const ZOOMS = [1, 1.25, 1.5, 2, 3];
const ZOOM_KEY = 'paperweave.pdfzoom';
/** A page's picture is never more than this many pixels: a canvas beyond it fails or crawls. */
const MAX_PIXELS = 12_000_000;

/** The word under a double-click in a page's text layer, if the click was on a word itself. */
function wordClicked(e: MouseEvent, holder: HTMLElement): string | undefined {
  const doc = document as Document & {
    caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?(x: number, y: number): Range | null;
  };
  let node: Node | null | undefined;
  let offset = 0;
  const pos = doc.caretPositionFromPoint?.(e.clientX, e.clientY);
  if (pos) [node, offset] = [pos.offsetNode, pos.offset];
  else {
    const r = doc.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (r) [node, offset] = [r.startContainer, r.startOffset];
  }
  if (!(node instanceof Text) || !holder.querySelector('.textLayer')?.contains(node)) return;
  const span = wordSpan(node.data, offset);
  if (!span) return;
  // The caret is the nearest place to the click, also from a blank part of the page: only a
  // click on the word's own words counts.
  const range = document.createRange();
  range.setStart(node, span.from);
  range.setEnd(node, span.to);
  const on = [...range.getClientRects()].some(
    (q) =>
      e.clientX >= q.left - 2 &&
      e.clientX <= q.right + 2 &&
      e.clientY >= q.top - 2 &&
      e.clientY <= q.bottom + 2,
  );
  return (on && wordIn(node.data, offset)) || undefined;
}

/**
 * A PDF drawn page by page, so that a place on a page can be pointed at and a double-click on a
 * page says where it was. A page is drawn when it comes near the window, with its words laid
 * over the picture of it: they can be selected, and a screen reader reads them.
 */
export default function PdfView(props: {
  src: string;
  mark: Mark | null;
  /**
   * `nearest`: the place is a guess at the middle of the pane, so the nearest thing will do.
   * `word`: the word that was clicked, which stays in the browser.
   */
  onPick(page: number, x: number, y: number, nearest?: boolean, word?: string): void;
  /** Set to a way of picking the place in the middle of what the pane is showing. */
  middle: { current: () => void };
}) {
  const { src, mark } = props;
  const host = useRef<HTMLDivElement>(null);
  const [problem, setProblem] = useState(false);
  const [drawn, setDrawn] = useState('');
  const pick = useRef(props.onPick);
  pick.current = props.onPick;
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  // Set by the effect that draws the pages: puts the words and the pictures right for the
  // width the pages now have.
  const refit = useRef<() => void>(() => {});

  // What was chosen before, read after mount so that the first draw matches the server's.
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(ZOOM_KEY));
      if (ZOOMS.includes(saved)) setZoom(saved);
    } catch {
      // Without storage the size is not remembered; nothing else is lost.
    }
  }, []);
  const choose = (z: number) => {
    if (z === zoom) return;
    setZoom(z);
    try {
      localStorage.setItem(ZOOM_KEY, String(z));
    } catch {
      // Without storage the size is not remembered; nothing else is lost.
    }
  };
  const step = ZOOMS.indexOf(zoom);

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
      pages.style.width = `${zoomRef.current * 100}%`;
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
        delete holder.dataset.at;
      };
      // A picture is right only if it was drawn at the width the page has now.
      const current = (holder: HTMLElement) =>
        holder.dataset.drawn === 'yes' && holder.dataset.at === String(holder.clientWidth);
      // One page at a time is drawn or released: PDF.js refuses a second render() on a canvas
      // that is still being drawn, as happens when a page leaves and comes back.
      const settle = async (holder: HTMLElement) => {
        if (busy.has(holder)) return;
        busy.add(holder);
        try {
          if (near.has(holder) && !current(holder)) await draw(holder);
          else if (!near.has(holder) && holder.dataset.drawn === 'yes') release(holder);
        } finally {
          busy.delete(holder);
        }
        const wrong = near.has(holder) ? !current(holder) : holder.dataset.drawn === 'yes';
        if (!stop && wrong && holder.clientWidth > 0) void settle(holder);
      };
      const draw = async (holder: HTMLElement) => {
        const page = await doc.getPage(Number(holder.dataset.page));
        if (stop) return;
        const canvas = holder.querySelector('canvas')!;
        const width = holder.clientWidth;
        const natural = page.getViewport({ scale: 1 });
        const fitted = width / natural.width;
        const [cssW, cssH] = [width, natural.height * fitted];
        if (!(cssW * cssH > 0)) return;
        holder.dataset.at = String(width);
        // Sharp on dense screens, but not more than twice the size, and not more pixels than
        // a canvas can be trusted with: a page enlarged to 300% is a very large picture.
        const scale =
          fitted * Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(MAX_PIXELS / (cssW * cssH)));
        const viewport = page.getViewport({ scale });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvas, viewport }).promise.catch(() => {});
        page.cleanup();
        // The page's words, invisible, each where the picture shows it. They stay when the
        // picture is released, so that what was read can still be selected and read aloud.
        const size = holder.clientWidth / natural.width;
        const old = holder.querySelector<HTMLElement>('.textLayer');
        if (old) {
          old.style.setProperty('--total-scale-factor', String(size));
          holder.dataset.drawn = 'yes';
          return;
        }
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
            false,
            wordClicked(e, holder),
          );
        });
        pages.append(holder);
      }
      if (stop) return;
      host.current.replaceChildren(pages);
      for (const holder of pages.children) watch.observe(holder);
      // The words follow the page's width at once, also on a page whose picture was let go;
      // the pictures of the pages that are near are drawn again at the new width.
      const fit = () => {
        for (const holder of pages.children as Iterable<HTMLElement>) {
          const words = holder.querySelector<HTMLElement>('.textLayer');
          if (words && holder.clientWidth > 0)
            words.style.setProperty(
              '--total-scale-factor',
              String(holder.clientWidth / Number(holder.dataset.width)),
            );
          void settle(holder);
        }
      };
      refit.current = fit;
      // The pane changes width with the window; the pages follow.
      let width = host.current.clientWidth;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const resized = new ResizeObserver(() => {
        const now = host.current?.clientWidth ?? width;
        if (now === width) return;
        width = now;
        clearTimeout(timer);
        timer = setTimeout(fit, 150);
      });
      resized.observe(host.current);
      setDrawn(src);
      const destroy = close;
      close = () => {
        watch.disconnect();
        resized.disconnect();
        clearTimeout(timer);
        refit.current = () => {};
        destroy();
      };
    })().catch(() => !stop && setProblem(true));
    return () => {
      stop = true;
      close();
    };
  }, [src]);

  // A new size: the pages take it, the place that was in the middle of the pane stays there,
  // and the words and pictures are put right for the new width.
  const shown = useRef(1);
  useEffect(() => {
    const el = host.current;
    const pages = el?.firstElementChild as HTMLElement | null;
    if (!el || !pages || drawn !== src || shown.current === zoom) {
      if (pages && drawn === src) shown.current = zoom;
      return;
    }
    shown.current = zoom;
    const down = (el.scrollTop + el.clientHeight / 2) / (el.scrollHeight || 1);
    const across = (el.scrollLeft + el.clientWidth / 2) / (el.scrollWidth || 1);
    pages.style.width = `${zoom * 100}%`;
    el.scrollTop = down * el.scrollHeight - el.clientHeight / 2;
    el.scrollLeft = across * el.scrollWidth - el.clientWidth / 2;
    refit.current();
  }, [zoom, drawn, src]);

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
    // As wide as the line's column, when that is known, not the whole page.
    const wide = Number(holder.dataset.width);
    const narrow = mark.left !== undefined && mark.width !== undefined && mark.width > 0;
    if (narrow) {
      band.style.left = `${(100 * mark.left!) / wide}%`;
      band.style.right = 'auto';
      band.style.width = `${(100 * mark.width!) / wide}%`;
    }
    holder.append(band);
    const top = holder.offsetTop + (holder.offsetHeight * mark.y) / height;
    // Sideways too, when the pages are wider than the pane: the band's middle in the middle.
    const across =
      narrow && el.scrollWidth > el.clientWidth
        ? holder.offsetLeft + (holder.offsetWidth * (mark.left! + mark.width! / 2)) / wide
        : null;
    el.scrollTo({
      top: Math.max(0, top - el.clientHeight / 3),
      ...(across !== null && { left: Math.max(0, across - el.clientWidth / 2) }),
    });
    // In a narrow window the pane is under the editor, off the screen: the band was shown to
    // nobody. Only the window is moved, and only when the band is not on the screen.
    const at = band.getBoundingClientRect();
    const by = intoWindow(at.top, at.bottom, window.innerHeight);
    if (by) window.scrollBy({ top: by });
    return () => band.remove();
  }, [mark, drawn, src]);

  return (
    <>
      {problem && <p role="alert">The PDF could not be shown here. Open it with the link above.</p>}
      <div className="pdf-zoom" role="group" aria-label="Size of the pages">
        <button
          type="button"
          aria-disabled={step <= 0}
          onClick={() => step > 0 && choose(ZOOMS[step - 1]!)}
        >
          Smaller
        </button>
        <button
          type="button"
          aria-disabled={step >= ZOOMS.length - 1}
          onClick={() => step < ZOOMS.length - 1 && choose(ZOOMS[step + 1]!)}
        >
          Larger
        </button>
        <button type="button" aria-disabled={zoom === 1} onClick={() => choose(1)}>
          Fit the width
        </button>
        <span aria-live="polite">{zoom === 1 ? 'Fits the width' : `${zoom * 100}%`}</span>
      </div>
      {/* Reachable from the keyboard, so that it can be scrolled and read without a pointer. */}
      <div className="pdf" ref={host} tabIndex={0} role="region" aria-label="Pages of the PDF" />
    </>
  );
}

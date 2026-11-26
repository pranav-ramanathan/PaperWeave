'use client';

import { type ReactNode, useEffect, useRef } from 'react';
import { useDefaultLayout, useGroupRef } from 'react-resizable-panels';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '../../../../../components/ui/resizable';

/** Where the sizes are kept: this browser's, and the page works without them. */
const kept = {
  getItem: (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Not kept; the panes are as they were made.
    }
  },
};

/**
 * The text and the PDF side by side with a handle between them, in the new look from 60rem (below
 * it editor.css stacks the panes and hides the handle). The handle comes after the text and
 * before the PDF in the page's order, so it is after the text in the Tab order. The PDF is drawn
 * again at its new size only on release (`resizePreviewMode`): the pointer moves a line, not the
 * pane, until it is let go; a key press is its own release.
 */
export default function Panes({ text, pdf }: { text: ReactNode; pdf: ReactNode }) {
  const layout = useDefaultLayout({
    id: 'paperweave-file-panes',
    panelIds: ['pane-text', 'pane-pdf'],
    storage: kept,
    onlySaveAfterUserInteractions: true,
  });
  // The page is drawn on the server without the sizes (they are this browser's), so the group
  // is given them once it is here (not as `defaultLayout`, which would not match what the server drew).
  const group = useGroupRef();
  const keptLayout = layout.defaultLayout;
  const given = useRef(false);
  useEffect(() => {
    // The first value it has, once: a later change is the person's own, and is what is kept.
    if (given.current || !keptLayout) return;
    given.current = true;
    group.current?.setLayout(keptLayout);
  }, [keptLayout, group]);
  return (
    <ResizablePanelGroup
      groupRef={group}
      className="panes"
      orientation="horizontal"
      resizePreviewMode="separator"
      onLayoutChanged={layout.onLayoutChanged}
    >
      <ResizablePanel id="pane-text" className="pane" defaultSize="55%" minSize="28rem">
        {text}
      </ResizablePanel>
      <ResizableHandle id="panes-handle" label="Resize the editor and the PDF" />
      <ResizablePanel id="pane-pdf" className="pane" defaultSize="45%" minSize="16rem">
        {pdf}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

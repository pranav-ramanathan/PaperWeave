# Accessibility

Where this stands, what holds it there, and what nobody has checked yet.

## Held by tests

`tests/e2e/a11y.spec.ts` runs in CI with the other browser tests.

- **An automated audit** (axe, WCAG 2.1 A and AA rules) of the sign-in page, the list of papers, a
  paper's page, a data file's page, the new-chart page, the checks before submitting, and the
  editor in both views with a spelling finding, a thread, a proposed change and the PDF showing,
  and the page for an address that leads nowhere. No failures.
- **The same audit on pages the first one did not visit**, run from the tests that already go
  there: the differences between two revisions, the lines a file rename or a label rename
  would change, an invitation and one that is no longer valid, a chart whose files have gone,
  and the first page a new person sees. No failures.
- **The same audit of the editor when it has stopped** (`recover.spec`): its person signed out,
  their role lowered, an edit too large to save, edits held after a restore, and both views
  for someone who can only read, on a file long enough to scroll.
- **One flow with the keyboard alone**: Tab into the visual editor, select words with Shift and
  the arrow keys, Tab to the comments, start a thread on the selection, go back to the toolbar,
  show the caret's line in the PDF, and Tab to the PDF itself.

- **A narrow window.** The same pages, and a drawn chart and the differences between two
  revisions, at 320 CSS pixels wide, which is what a 1280-pixel window becomes at 400% zoom:
  none has to be scrolled sideways to be read. A wide table scrolls
  sideways inside itself, and can be reached and scrolled from the keyboard.
  - This found three pages that did need sideways scrolling: a paper's page, a data file's
    page and the editor. On the editor's page the files, the editor and the PDF now sit one
    under another in a narrow window.
  - It checks that nothing sticks out. It does not check that what is there is comfortable to
    use at that size; two of the pages were looked at by eye and read well.

- **Between the text and the PDF, both ways, with the keyboard** (`synctex.spec`). From the
  text, a button shows the caret's line in the PDF. From the PDF, the pages are scrolled with
  the keyboard until the passage is in the middle of the pane, and a button goes to the text
  for what is there, in whichever file it is.
  - It is coarser than a double-click, which picks a word: it picks what is nearest the middle
    of the pane. On a page with two columns it cannot say which column is meant.

- **The colours of a drawn chart** (`charts.test`). A chart is printed on white, and each of
  its eight colours is dark enough against white to be made out: at least 3 to 1.
  - Three of the eight used before were not: an orange at 2.3 to 1, a light blue at 2.3 and a
    yellow at 1.3. The orange was the second colour, so any chart with two groups had it.
  - The new ones are from a published scheme made for colour-blind readers (Paul Tol's
    "muted"), keeping those dark enough for white. In a simulation of the three kinds of
    colour-blindness the closest two are a little closer than the old set's closest two were
    (14 against 16 on the measure used), which is the price of every colour being dark enough.
  - Groups are also told apart without colour: by the shape of a point, the dashes of a line,
    the place of a bar.

Other browser tests hold narrower things: composing text with an input method while someone
else edits the same paragraph (`spike.spec`), switching views with the selection kept
(`visual.spec`), and the equation, reference, citation, figure and table windows opened from
the keyboard (`insert.spec`).

## What the audit and that flow found, now fixed

- The PDF pane scrolled but could not be reached from the keyboard. It now takes the keyboard
  and has a name.
- The pages of the PDF were pictures with nothing to read. Each page now has its words laid
  over it: a screen reader reads them and they can be selected.
- Tabbing into the visual editor gave it the keyboard and no caret, so the arrow keys did
  nothing. A file begins with its preamble, which is not text, and the browser had nowhere to
  put the caret. The caret now goes where the editor's own selection is.
- Selecting with the keyboard and then tabbing away could lose the end of the selection: a
  comment was started on "Lat" when "Latency" was selected. Comments, proposed changes and
  "Show in PDF" now read the selection as it is on the screen.

- A source editor that had stopped taking edits could not be reached from the keyboard at
  all, so it could only be scrolled with a mouse. That is every state in which someone is
  told to read or copy what is there: a person who can only read, a role lowered, an edit too
  large to save ("copy what you need"). It now takes the keyboard, and a test moves through a
  long file in it, and selects from it, with keys alone. Found by running the audit in those states, which the
  first audit did not visit.

## Status without colour

- A thread's text is tinted and has a solid line under it; a proposed change has a dashed
  line; a spelling or grammar finding has a wavy line.
- A proposal says "Now:" and "Proposed:" in words beside the struck and added text, and says
  "Out of date" in words.
- A claim flag is a bordered box that begins "This changes more than the wording".
- Saved, offline, held and refused states of the editor are sentences in a live region.
- The band that shows a line in the PDF has an outline, and the place is also said in words.
- Another person's caret in the visual view carries their name (drawn by the stylesheet, not in
  the text) and is `aria-hidden`; the "Also here" line is what a screen reader gets.

## Not checked

- **A real screen reader.** Nothing here has been listened to with NVDA, JAWS or VoiceOver. The
  audit checks names and roles; it does not check that what is announced makes sense, or that
  live regions speak at the right moments. This is the largest gap.
- **Browsers other than Chromium.** Firefox and Safari have not been run at all.
- **Real input methods.** The composition test drives the browser's composition events; no
  Japanese, Chinese or Korean input method has been typed with.
- **Zoom, beyond the narrow-window test above.** Not checked: text enlarged by itself without
  the page being zoomed, wider spacing between letters and lines, and a narrow window on the
  pages the test does not visit (renaming a file, the windows for inserting things).
- **Formulas.** The audit checks the page's own text. A formula is drawn in the page's ink
  colour, so it should pass where the text around it does; that has not been measured.
- **Whether a chart's colours stay apart for colour-blind readers, in people's eyes.** It was
  checked by simulating colour-blind vision (see above).

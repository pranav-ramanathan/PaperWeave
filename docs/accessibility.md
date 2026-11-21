# Accessibility

Where this stands, what holds it there, and what nobody has checked yet.

## Held by tests

`tests/e2e/a11y.spec.ts` runs in CI with the other browser tests.

- **An automated audit** (axe, WCAG 2.1 A and AA rules) of the sign-in page, the list of papers, a
  paper's page, a data file's page, the new-chart page, the checks before submitting, and the
  editor in both views with a spelling finding, a thread, a proposed change and the PDF showing,
  a comment being changed and the question before one is deleted (`threads.spec`),
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

- **The keyboard after a comment or a proposed change** (`keys.spec`). Opening the form for a
  comment or a proposed change puts the keyboard in its text field; sending it, or putting it
  away, puts the keyboard back on the button that opened it; resolving a thread and accepting a
  proposal leave the keyboard in that part of the page and say what happened in words. The
  window for an equation takes what is typed straight after it opens.

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

- On pressing Enter on "Comment on the selected text" or "Propose a change here", the button
  went and the form that replaced it was not given the keyboard: nothing had it, and what was
  typed went nowhere. Sending the form, resolving a thread and accepting, rejecting or
  withdrawing a proposal did the same (the thing the keyboard was on is gone, and the proposal
  or thread moves into a list that is closed), and the result was not said anywhere.
- The window for an equation opened with the keyboard on "In the line", so the formula typed
  after Alt+= went nowhere (a space would have changed the choice). It now opens on the LaTeX field.

## Walked with the keyboard alone, from sign-in to the revision's downloads

One run of the beta path in Chromium with Playwright, pressing keys only (Tab, Shift+Tab, Enter,
Space, arrows, Escape, Alt+R/C/=/T, Ctrl+I, Shift+F10); the mail links were opened as an email
client would. The paper was `fixtures/ieee-multifile`, a second person was invited as an editor.

- **Works.** Asking for a sign-in link (the email field is the third Tab stop); importing a ZIP
  (Space on the file field opens the browser's chooser; "Import ZIP" is the next Tab);
  inviting (the role is changed with the arrow keys); joining from the invitation; opening a
  file from the list; typing in both views; emphasis by Ctrl+I and by the "Emphasise" button
  (the button keeps the keyboard and the selection); a reference, a citation, an equation and a
  table from Alt+R, Alt+C, Alt+= and Alt+T, each closed with Enter on Insert or with Escape,
  and the keyboard back in the text afterwards; the menu "At this place" from Shift+F10, opened
  at the caret with its first item focused, closed with Escape; switching views (the keyboard
  moves into the editor that is shown); "Compile now" (the status says "The PDF is up to date.");
  saving a named revision; "Build the PDF for revision N"; the revision's "ZIP" and "PDF" links
  (both download: `attachment`, named `<paper> rN.zip` and `.pdf`).
- **Dialogs** are native and modal: Tab goes round the window and through the browser's own
  controls (nothing has the page's focus for one press) and back. The table window's caption
  is required: Enter on Insert with it empty puts the keyboard in the caption and the browser
  says "Please fill out this field."
- **Fixed above:** the keyboard in the comment, proposal and equation forms; the keyboard after
  they are sent or put away; resolving a thread and deciding a proposal.
- **Not changed, for a decision.**
  - After any form that posts (Import ZIP, Send invitation, Save revision, Build the PDF for a
    revision, Restore) the page is drawn again with nothing focused, and the result ("Invitation
    sent to…", "Saved as revision N.") is a `role="status"` line that was in the page as it
    loaded. Whether a screen reader says it has not been listened to. A keyboard user begins
    again from the top of the page.
  - There is no way past the lists at the top of a page. The paper's page is 47 Tab stops from
    the top to "Their email address" and 47 more from the revision's name field to its "ZIP"
    link; the file's page is 43 stops from the top to the visual editor (the list of files
    first), 20 on the smaller paper in `keys.spec`. No skip link; the headings and regions are
    there for a screen reader's own jumps.
  - The visual view has no way to make or change a heading, by any means (the toolbar has
    Emphasise, Undo, Redo and the insert buttons). A heading is typed in the source view.
  - The same loss of the keyboard on closing is in the code, and was not walked or changed, for
    "Change the proposal" (Save the proposal), changing a comment (Save), deleting a comment (the
    question and its answer) and "Reply".
  - Editing an existing formula from the keyboard (Enter on a selected formula) was not
    confirmed: the arrow keys selected a display formula and raw blocks in one run, and an inline
    formula could not be reached the same way in the run that tried it.
  - Pressing Alt+T within about a tenth of a second of closing the table window with Escape did
    not open it once; slower, it did. Not reproduced since.

## Status without colour

- A thread's text is tinted and has a solid line under it; a proposed change has a dashed
  line; a spelling or grammar finding has a wavy line.
- A proposal says "Now:" and "Proposed:" in words beside the struck and added text, which is the
  changed words only, and says "Out of date" in words.
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

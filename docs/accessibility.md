# Accessibility

Where this stands, what holds it there, and what nobody has checked yet.

- Every page's `<title>` was "PaperWeave" (WCAG 2.4.2), so a page that opened said nothing to tell
  it from another. Each now says where it is: "Papers", the paper's name, "main.tex · <paper>",
  "Check before submitting · <paper>", "Describe a data file · <paper>", "New chart · <paper>"
  (or "Chart <name>"), "Rename a file", "Rename a label", "Revision 1 to revision 2",
  "Invitation to <paper>", "Sign in", "Nothing here" and "This page could not be shown", each
  followed by "— PaperWeave". A paper's name is in a title only from the same check and the same
  read the page makes, so someone who is not on the paper gets "Nothing here". `titles.spec.ts`
  holds this; the error page's title is not tried (nothing in the tests makes a page fail).

## Held by tests

`tests/e2e/a11y.spec.ts` runs in CI with the other browser tests.

- **An automated audit** (axe, WCAG 2.1 A and AA rules) of the sign-in page, the list of papers, a
  paper's page, a paper's page with a revision that has no PDF, a data file's page, the new-chart
  page, the checks before submitting, and the
  editor in both views with a spelling finding, a thread, a proposed change and the PDF showing,
  a comment being changed and the question before one is deleted (`threads.spec`),
  and the page for an address that leads nowhere. No failures.
- **Two more states of the audit** (`numbers.spec`, `charts.spec`, `submit.spec`): a reference
  whose number is behind the text, a chart waiting to be drawn, and the checks while a build
  runs. They failed before: the stale reference was faded with `opacity: 0.65` (about 2.9:1,
  WCAG 1.4.3); it is now in the muted colour (italic and its title stay as the cue that is not
  colour). The two waiting pages reloaded themselves with `<meta http-equiv="refresh">` every
  2 seconds (WCAG 2.2.1, axe `meta-refresh`), which starts a screen reader from the top and
  drops the keyboard's place. `Again` (`apps/web/app/Again.tsx`) asks for the page again with
  `router.refresh()` instead; the tests check that no such `<meta>` is there and that a focused
  link is still focused after 2.5 seconds. No `<noscript>` refresh is kept: with scripts off
  the page says to load it again.

- **The same audit on pages the first one did not visit**, run from the tests that already go
  there: the differences between two revisions, the lines a file rename or a label rename
  would change, an invitation and one that is no longer valid, a chart whose files have gone,
  and the first page a new person sees. No failures.
  - The audit with a line long enough to scroll the differences found `scrollable-region-focusable`
    (serious): the `<pre class="diff">` scrolled but could not be focused. It is now
    `role="region"` named "Changes to <file>" with `tabIndex={0}` and a visible focus outline,
    like `Wide`; `tests/e2e/a11y.spec.ts` holds it.
- **Both texts are always a tab stop.** The source and the visual view carry `tabindex="0"`
  whether or not the person can edit, so a long paper opened read-only can be reached and
  scrolled with the keyboard, and the audit passes on long files. The old "visual view for
  someone who cannot edit" audit had run on the source view (the view last used is remembered);
  `recover.spec` now shows the view it audits.
- **A reviewer can select in the visual view with the keyboard.** For someone who cannot write
  the visual text is `contenteditable="true"` with `aria-readonly="true"`, so Tab gives a caret
  and Shift+arrows select the words to comment on or propose a change to. Every change they try
  (typing, delete, Enter, undo, paste, drop, IME) is refused with a short note and the paper is
  unchanged; `keys.spec` holds it.
- **The keys that insert in the visual view**: Alt+R (reference), Alt+C (citation), Alt+= (equation),
  Alt+G (figure), Alt+T (table), Alt+H (heading), Alt+L (bulleted list) and Alt+N (numbered
  list), Ctrl+I (emphasis), Ctrl+B (bold) and Shift+F10 (the menu at
  the caret). Each toolbar button names its key in `aria-keyshortcuts`. The heading window opens
  on its Title, Enter inserts, Escape closes it and gives the caret back, a refusal is read from
  its alert, and axe passes with the window open and a refusal showing (`insert.spec`).
  Alt+H is Firefox's Help menu key on Windows and Linux when the page does not take it, as Alt+T
  is Tools; the editor takes both while it has the keyboard. Alt+L and Alt+N have no menu in
  Firefox. A list is put in at once; the caret goes into its item.
- **Removing a block in the visual view.** A figure or table has a "Remove" button after
  "Edit in source", named "Remove figure" or "Remove table" (`aria-label`; the visible word is
  part of it) and reached by Tab. It is not drawn for people who can only read. Backspace or
  Delete in an empty heading, and Backspace in an empty list item, remove it from the keyboard;
  the caret moves to the nearest text. axe passes with the button showing (`insert.spec`).
- **The same audit of the editor when it has stopped** (`recover.spec`): its person signed out,
  their role lowered, an edit too large to save, edits held after a restore, and both views
  for someone who can only read, on a file long enough to scroll.
- **One flow with the keyboard alone**: Tab into the visual editor, select words with Shift and
  the arrow keys, Tab to the comments, start a thread on the selection, go back to the toolbar,
  show the caret's line in the PDF (Shift+Tab to the toolbar, End, Enter), and Tab to the PDF
  itself.

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

- **A way past the lists, and the result of a form** (`keys.spec`). A file's page begins with
  "Skip to the text": Tab, Enter, Tab reaches the visual editor, or the source editor in the
  source view (3 presses; 14 before on the small paper). The paper's page has an "On this page"
  list, and "Their email address" is 8 presses from the top (19 before). The line a form
  leaves ("Saved as revision 1.", "Building the PDF…", "Restored.", "Invitation sent to…")
  has the keyboard, and the next Tab is the next field of that form's part. Changing, saving,
  cancelling and deleting a comment, replying, and changing a proposal leave the keyboard in
  that part of the page.

- **The toolbar is one Tab stop** (`keys.spec`). It is a `role="toolbar"` named "Editor tools",
  with its three groups inside. Tab enters it on one button and leaves it; Left and Right move
  along the 11 buttons and go round at the ends; Home and End go to the ends; it remembers the
  button that was left, and still does when the Edit group goes (the source view has 3
  buttons). Measured on the small paper: from the toolbar to the text 11 Tab presses, now 1;
  from the top of the file's page to the text, without the skip link, 15, now 5.
- **Ctrl+Home and Ctrl+End in the visual editor** (`keys.spec`) put the caret at the start of
  the first text and the end of the last text, and with Shift select out to them. They did
  nothing before: the paper starts and ends with drawn blocks (the preamble and
  `\end{document}`), and the browser's own move to the start or end of the document found no
  place for a caret. Checked with Ctrl in Chromium only; Cmd+Home on a Mac uses the same
  binding, and Cmd+Up and Cmd+Down have not been tried.
- **The other pages' refusal lines have the keyboard** (`keys.spec`): the checks before
  submitting, a data file, a chart, the two renames and an invitation (both of its lines). This
  was tried by loading the address a refusal returns to, with `?error=` on it, not by provoking
  each refusal. The checks page and a chart that is waiting to be drawn reload themselves every
  2 seconds; while the address carries `?error=`, the line takes the keyboard again each time.
- **A formula is opened for editing with the keyboard** (`keys.spec`). With the caret before an
  inline formula, Right selects it and Enter opens "Edit formula" on the LaTeX field; Apply puts
  the keyboard back in the text. Enter opens any selected inline atom the same way (a citation, a reference, a footnote, other raw LaTeX), as "Edit citation", "Edit reference", "Edit footnote" or "Edit LaTeX". From the top of the test paper Right is pressed 5 or 6 times
  (over the preamble, then the words). A display formula is selected by Down from the paragraph
  above (1 to 4 presses in 12 runs, depending on where the caret was) and Enter opens it. The
  browser stepped over an inline formula before: with the editor's selection one key behind,
  Left and Right now bring it up to date first, as Enter, Backspace and Delete already did. 11 of
  12 runs failed without that and 12 of 12 passed with it. Straight after Apply, five presses of Down did not reach the display formula; one press of Right first did.

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
- The pages of the PDF were fixed at the width of a pane too narrow to read small type in. They
  can now be enlarged to 300% with buttons (Smaller, Larger, Fit the width); the pane scrolls
  sideways within itself, not the page.

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
- The menu "At this place" opened off the bottom of the window when the caret was on the last
  line: its top was at the caret, its items below the edge, and the keyboard was on one nobody
  could see (2.4.7). In a window 480 pixels high it was taller than the window. It now measures
  itself before taking the keyboard, opens above the caret if it does not fit below, stays
  inside the window sideways, and scrolls inside itself if the window is shorter than it.
- A picture with no description had a button whose name ("Description of dot.png: none. Edit")
  did not contain the words it shows ("None yet. Add one."), so a voice-control user could not
  say what they saw (2.5.3). The name of the buttons for a cell, a caption and a description
  now holds the words shown.
- Enter on a cell, a caption or a description that had not been changed closed the field and
  left the keyboard on the page body (2.4.3). It now returns to the button, as Escape does.
- On a window 320 pixels wide a long formula made the preview in the equation window scroll
  sideways with no way to reach it from the keyboard. It is now a named group that takes the
  keyboard, with a visible outline.
- Taking a spelling or grammar finding with the keyboard ("Change to", "It is a word of this
  paper", "Do not check this in this paper", a reviewer's "Propose") removed the finding and
  left the keyboard on the page body (2.4.3), and "Change to" said nothing (4.1.3). The keyboard
  now goes to the next finding's first button, or to the panel's heading when none is left. Only
  when it had been lost: a click in the editor is not disturbed. The note says what was done
  ("Changed “recieve” to “receive”."). The words are shown on the page only, never logged.
- A reply sent with Enter on a "Mention" checkbox left the keyboard on the page body, because the
  list of people closes after a send (2.4.3). The keyboard now goes to the reply's text box.
- On a window 320 pixels wide the chart page scrolled sideways when a column heading was long,
  because the select for a column was as wide as its longest choice (1.4.10). Selects on the
  pages are now at most as wide as their container.
- Two controls were under 24 pixels tall (2.5.8): "Rename" and "Edit in source". Both are now at
  least 24 pixels tall.
- A proposal's Accept, disabled because the proposal is out of date, now names the "Out of
  date" note as its description (4.1.2), so a screen reader says why it cannot be used.

## Walked with the keyboard alone, from sign-in to the revision's downloads

One run of the beta path in Chromium with Playwright, pressing keys only (Tab, Shift+Tab, Enter,
Space, arrows, Escape, Alt+R/C/=/T, Ctrl+I, Shift+F10); the mail links were opened as an email
client would. The paper was `fixtures/ieee-multifile`, a second person was invited as an editor.

- **Works.** Asking for a sign-in link (the email field is the third Tab stop); importing a ZIP
  (Space on the file field opens the browser's chooser; "Import ZIP" is the next Tab);
  inviting (the role is changed with the arrow keys); joining from the invitation; opening a
  file from the list; typing in both views; emphasis and bold by Ctrl+I, Ctrl+B and by the "Emphasise" and "Bold" buttons
  (the button keeps the keyboard and the selection); a reference, a citation, an equation and a
  table from Alt+R, Alt+C, Alt+= and Alt+T, each closed with Enter on Insert or with Escape,
  and the keyboard back in the text afterwards; the menu "At this place" from Shift+F10, opened
  at the caret with its first item focused, closed with Escape; switching views (the keyboard
  moves into the editor that is shown); "Compile now" (the status says "The PDF is up to date.");
  saving a named revision; "Build PDF for revision N"; the revision's "ZIP" and "PDF" links
  (both download: `attachment`, named `<paper> rN.zip` and `.pdf`).
- **Dialogs** are native and modal: Tab goes round the window and through the browser's own
  controls (nothing has the page's focus for one press) and back. The table window's caption
  is required: Enter on Insert with it empty puts the keyboard in the caption and the browser
  says "Please fill out this field."
- **Fixed above:** the keyboard in the comment, proposal and equation forms; the keyboard after
  they are sent or put away; resolving a thread and deciding a proposal.
- **Fixed after this walk.**
  - The result of a form that posts (Send invitation, Save revision, Build PDF for a
    revision, Restore, Role changed, Import on the list of papers) is a line that takes the
    keyboard when it appears or says something new, so the next Tab goes on from the form that
    was sent. The revision, role and invitation results sit directly under the heading of their
    own part. A plain visit takes nothing.
  - The paper's page has a list of links, "On this page", to its sections, and the file's page
    a "Skip to the text" link that shows when it has the keyboard. Measured on the small paper
    in `keys.spec`: Tab stops from the top to "Their email address" 19, now 8; to the visual
    editor 14, now 3 (Tab, Enter, Tab; the same in the source view). On `fixtures/ieee-multifile`
    the walk counted 47 and 43 before.
  - Changing, saving, cancelling and deleting a comment, replying, and "Change the proposal" /
    "Save the proposal" left nothing with the keyboard. The keyboard now goes to the question,
    the button or the heading, and the live line says "Comment changed.", "Reply sent.",
    "Comment deleted." or "Proposal changed.". A Reply, Save or Propose button that is waiting is
    `aria-disabled` and not `disabled`: Chromium took the keyboard off a disabled button.
  - The toolbar is one Tab stop, reached with Shift+Tab from the text, and moved along with the
    arrow keys, Home and End (11 Tab presses before, 1 now).
  - The refusal lines of the checks, data, chart, rename and invitation pages take the keyboard
    like the others.
  - Right and Left could step over an inline formula without selecting it, so Enter did not
    open it; they now do.
- **Not changed.**
  - The visual view has no way to make or change a heading, by any means (the toolbar has
    Emphasise, Bold, Undo, Redo and the insert buttons). A heading is typed in the source view. This
    is a feature, not a fix.
  - Pressing Alt+T within about a tenth of a second of closing the table window with Escape did
    not open it once; slower, it did. Not reproduced since.
  - The same result twice in a row (Build pressed twice gives `?building=1` both times) does not
    take the keyboard again. Loading an address that still carries a result takes it again.
  - The 47 stops inside the Revisions table, from the name field to a row's ZIP link.

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

- **The toolbar with a screen reader.** Its role, name and groups are checked by the audit only;
  nobody has listened to it.
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

# Prism: what public sources say

Gathered on 18 November 2026 from public pages only. Nothing here was observed in a Prism account.
OpenAI's own pages (the launch post and the migration guide) refused automated fetches, so every
OpenAI statement below is as quoted by a third party. None of the third-party authors says they
ran a real export, and one says he did not.

## The export

| Question                                  | Answer                                                                                                                                 | Confidence                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| How to export                             | Settings, Data Controls, "Export all projects (zip)"; or "Export (zip)" in a project's title menu                                      | Four third-party guides agree          |
| What is in the ZIP                        | The project's `.tex`, `.bib` and figure files                                                                                          | Agreed, quoting OpenAI's guide         |
| What is not                               | Project history, inline comments, collaborator permissions, the live Zotero connection                                                 | Agreed, quoting OpenAI's guide         |
| Extras                                    | `export-errors.json` when an export fails. Some all-project archives hold a folder of chat conversations as JSON, "for reference only" | Named by several guides; shape unknown |
| Shared projects you do not own            | Files are exported, your conversation history is not                                                                                   | Three guides                           |
| Compiled PDF                              | Not in the ZIP; downloaded separately from the PDF viewer                                                                              | Implied by all four guides             |
| Folder layout of the all-projects archive | Not stated anywhere                                                                                                                    | Unknown                                |
| Root file or compiler recorded            | Not stated anywhere                                                                                                                    | Unknown                                |
| Encoding or size limits                   | Not stated anywhere                                                                                                                    | Unknown                                |
| Shutdown                                  | 1 January 2027; data is deleted afterwards and cannot be recovered                                                                     | Agreed, quoting OpenAI                 |

### What this means for the importer (plan C2, E5)

- A Prism ZIP is a plain LaTeX ZIP. It goes through the same import path as an Overleaf ZIP.
- There is no review data to import. The import report says history, comments and permissions were
  not in the archive.
- Root file and compiler have to be detected, as for any ZIP.
- An all-projects archive may hold several projects: the importer should list the projects it
  finds and let the author pick, rather than assume one project per ZIP.
- `export-errors.json` and a conversations folder are listed in the archive inventory and
  otherwise ignored.

A real export would settle the folder layout and the shape of the conversations JSON. It is useful
if someone with an account has one, and not needed to build the importer.

## The product

From two university-library hands-on reviews (February and March 2026) and one news report.

- **Editor.** Source-only LaTeX with a PDF preview, in the browser. No visual editor, no symbol
  palette, no templates, no Git or GitHub sync. Compile time is not limited.
- **Collaboration.** Real-time co-editing with unlimited collaborators, inline comments and
  threads, view or edit permissions. Sources disagree on version history: one review lists none,
  an OpenAI help page is quoted as saying there is one.
- **Assistant.** A chat with the full project as context. It proofreads, fixes references and
  compile errors, converts photos of handwriting or whiteboards to LaTeX, and generates diagrams.
- **Agents.** They search literature, cross-check citations and update project files. Several can
  run at once. Each proposed change waits for the author to keep or undo it.
- **References.** Zotero sync and a built-in literature search that suggests BibTeX entries.
- **Weak spots reviewers found.** Generated TikZ that was over-complicated or did not compile; a
  literature agent too thin to rely on; a reference list that changed between two runs.

### What this means for PaperWeave

- The plan's bets are things Prism lacks: a visual editor, review data that can be exported, and
  edits flagged when they change a claim.
- Prism has one thing the plan does not: agents that work across the project on their own. The
  plan has an explicit Review action that proposes edits (E4). Adding agents would be new scope in
  Phase E and is the owner's decision.

## Sources

- [Purplelink: Move a Prism project to a Mac before it shuts down](https://purplelink.llc/guides/move-prism-project-to-mac/)
- [LetX: Prism Shutting Down: Why, and How to Export Projects](https://letx.app/blog/prism-shutting-down/)
- [DEV: Prism shuts down Jan 1, 2027](https://dev.to/mergisi/prism-shuts-down-jan-1-2027-export-your-projects-to-overleaf-without-losing-work-38oh)
- [Automater: OpenAI Is Shutting Down Prism on Jan. 1, 2027](https://automater.ai/news/openai-prism-shutdown-january-2027-export-codex/)
- [HKUST Library: Prism, a new AI LaTeX editor for academic writing](https://library.hkust.edu.hk/news-events/news/prism-new-ai-latex-editor-academic-writing)
- [SMU Libraries: Goodbye Overleaf? An exploration of OpenAI's Prism](https://library.smu.edu.sg/topics-insights/goodbye-overleaf-exploration-openais-prism)
- [InfoQ: OpenAI Prism](https://infoq.com/news/2026/01/openai-prism)
- [OpenAI: Prism to Codex migration guide](https://help.openai.com/en/articles/20001615-prism-to-codex-migration-guide)
  (not readable by automated fetch; quoted via the pages above)

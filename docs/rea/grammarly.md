# Grammarly: what public documentation says

Gathered on 18 November 2026 from public pages only, by an automated reader. Nothing here was
observed in a Grammarly account. Grammarly's pages were read through a tool that summarises, so
the short quotations below should be checked against the page before being repeated as
Grammarly's words.

## Replay 4: rewriting a paragraph with numbers and hedges

| Question                    | What the pages say                                                                                                                                                                                             | Kind                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Rewrites                    | Select text and it suggests improvements; a paragraph can be improved, rephrased, shortened, or made more formal or friendly, then accepted                                                                    | stated               |
| Is each change shown?       | For sentence rewrites, an option highlights what changed against the original                                                                                                                                  | stated               |
| Is each change explained?   | "Grammarly provides explanations to help users make informed decisions", as a general statement. Whether every rewrite has its own is not said                                                                 | stated; not stated   |
| Numbers, statistics, hedges | No page mentions keeping them                                                                                                                                                                                  | not stated           |
| Meaning                     | One claim, for the paraphraser: "Keep your ideas intact"                                                                                                                                                       | stated               |
| Warnings                    | Generative text has "inherent limitations and risks"; "human judgment" matters "especially when dealing with complex or sensitive material"; of a rewrite, "double-check that the new information is accurate" | stated               |
| Inside LaTeX                | Nothing from Grammarly. Overleaf's own page says it "does not fully understand LaTeX markup, occasionally resulting in erroneous suggestions and words not being spell-checked"                                | stated (by Overleaf) |

**For PaperWeave.** The two things the plan treats as requirements are the two things no page
promises:

- **A rewrite that changes a quantity, a negation, a cause or a hedge is flagged**, whoever
  proposed it (plan E4; `claims.ts` and its challenge set).
- **The checker is not shown LaTeX it would misread.** Formulas, commands, units, paths and
  citations are kept from it, and the benchmark fails on a finding inside one (plan E3;
  `docs/grammar-benchmark.md`).

A live replay would show what Grammarly does to a hedge or a number in practice. That would be
a useful example for the challenge set. Nothing in the build waits on it.

## Sources

- [Grammarly: generative AI in Grammarly](https://support.grammarly.com/hc/en-us/articles/14528857014285)
- [Grammarly: paragraph rewrites](https://support.grammarly.com/hc/en-us/articles/30916398193037)
- [Grammarly: rewriting whole sentences for clarity](https://www.grammarly.com/blog/product/transform-whole-sentences-clarity-suggestions/)
- [Grammarly: responsible AI](https://www.grammarly.com/responsible-ai)
- [Grammarly: AI rewrites](https://www.grammarly.com/blog/writing-with-ai/ai-rewrites/)
- [Overleaf: using Grammarly with Overleaf](https://docs.overleaf.com/integrations-and-add-ons/grammarly.md)

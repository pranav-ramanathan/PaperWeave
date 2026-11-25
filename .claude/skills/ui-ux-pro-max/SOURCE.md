# Source

- Repo: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill (path `.claude/skills/ui-ux-pro-max`)
- Commit: 8db36338810d0942567b97ce439affd1619fcf31
- Copied: 2026-11-25
- Licence: MIT, Copyright (c) 2024 Next Level Builder (`LICENSE`)

Left out: `scripts/tests/`, `scripts/validate_data.py`, and the large JSON provenance
files in `data/`. None are needed to run the search.

Note: SKILL.md calls the script as
`python "${CLAUDE_PLUGIN_ROOT}/.claude/skills/ui-ux-pro-max/scripts/search.py"`.
`CLAUDE_PLUGIN_ROOT` is not set for a project skill; use the repo-relative path
`.claude/skills/ui-ux-pro-max/scripts/search.py` instead.

The scripts are local-only (stdlib, no network, no subprocess). They write files
only with `--persist` or `--preview`, under `--output-dir` or a temp file.

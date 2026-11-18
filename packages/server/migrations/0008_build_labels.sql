-- The number and page LaTeX gave each label in a build, read from its .aux files:
-- {"sec:intro": {"number": "1", "page": "1"}, ...}. This is what \ref prints in that build's PDF.
alter table builds add column labels jsonb;

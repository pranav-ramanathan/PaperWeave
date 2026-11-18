-- How a paper's prose is checked: British or American spelling, the paper's own words (names,
-- coinages, abbreviations) that are not spelling mistakes, and the rules its authors have
-- switched off.
alter table projects add column language text not null default 'en-GB'
  check (language in ('en-GB', 'en-US'));
alter table projects add column glossary jsonb not null default '[]';
alter table projects add column grammar_off jsonb not null default '[]';

-- The project paths TeX opened in a build, a JSON array, from latexmk's .fls. The ZIP of only the
-- files the paper uses (`exportRevision`'s `used`) leaves out what a good build never read. Null
-- for a build made before this was recorded, for one that failed, and for one whose TeX did not
-- run: nothing is then left out.
alter table builds add column read jsonb;

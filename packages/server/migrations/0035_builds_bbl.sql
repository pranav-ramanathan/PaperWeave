-- The digest of the .bbl a build's TeX read (the file BibTeX or Biber made, or the paper's own),
-- kept when the build made a PDF and the file is not empty. The ZIP of only the files the paper
-- uses (`exportRevision`'s `used`) puts it beside the root, for a venue that runs neither BibTeX
-- nor Biber. Null for a build made before this was recorded and for one with no .bbl.
alter table builds add column bbl_digest text;

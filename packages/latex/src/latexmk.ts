// latexmk runs with -norc, so a project's latexmkrc is never read and latexmk has no rules for
// glossaries or nomenclature. These are our own, passed with -e (which -norc does not stop).
// Shared by the build and by the command in a revision's download, so both make the same PDF.
//
// Rules, as latexmk custom dependencies:
//   .glo -> .gls, .acn -> .acr, .slo -> .sls   makeglossaries (glossaries)
//   .nlo -> .nls                               makeindex with nomencl.ist (nomencl), or
//                                              makeglossaries when the .aux has \@istfilename:
//                                              then the .nlo is glossaries' `numbers` glossary
// BibTeX is run through pw_bib, which leaves a ready-made .bbl alone when the .aux has no
// \bibdata (a paper that \input's its own .bbl): real bibtex runs only where a .bib is named.
// When a paper names a .bib it does not have and has no .bbl, latexmk will not run BibTeX or
// biber, so the .bbl never appears and the build ends as "needed too many passes" with no PDF kept.
// pw_bbl runs after each TeX run: when the log says there is no <root>.bbl, it makes an empty one,
// so the build ends after a normal pass and the PDF has [?] for the citations. It says so on
// latexmk's output ("PaperWeave: no main.bbl, an empty one stands in."), which the worker reads.
// A .bbl that is there is never touched. It runs no command.
// Every command is run by list-form system(), so no shell reads a file name. The string holds
// no single quote: it is put inside '...' in a shell command.
export const LATEXMK_RULES = String.raw`add_cus_dep(q(glo),q(gls),0,q(pw_gls));add_cus_dep(q(acn),q(acr),0,q(pw_gls));add_cus_dep(q(slo),q(sls),0,q(pw_gls));add_cus_dep(q(nlo),q(nls),0,q(pw_nlo));sub pw_gls{my($b,$p)=fileparse($_[0]);return system(q(makeglossaries),q(-d),$p,$b);}sub pw_nlo{my $a=qq($_[0].aux);if(open(my $h,q(<),$a)){local $/;my $t=<$h>;close $h;return pw_gls(@_) if $t=~/\\[@]istfilename/;}return system(q(makeindex),q(-s),q(nomencl.ist),q(-t),qq($_[0].nlg),q(-o),qq($_[0].nls),qq($_[0].nlo));}$bibtex=q(internal pw_bib %S);sub pw_bib{my($a)=@_;my @q=($a);my %s;while(defined(my $f=shift @q)){next if $s{$f}++;open(my $h,q(<),$f) or next;while(<$h>){return system(q(bibtex),$a) if /^\\bibdata\{/;push @q,$1 if /^\\[@]input\{(.*)\}/;}close $h;}return system(q(bibtex),$a) if !-e $a;(my $b=$a)=~s/\.aux$/.blg/;if(open(my $h,q(>),$b)){print $h qq(No \\bibdata in $a: BibTeX not run.\n);close $h;}print qq(No \\bibdata in $a: BibTeX not run.\n);return 0;}add_hook(q(after_xlatex),q(pw_bbl));sub pw_bbl{my $b=qq($aux_dir1$root_filename);return if -e qq($b.bbl);open(my $h,q(<),qq($b.log)) or return;local $/;my $t=<$h>;close $h;return unless $t=~/^No file \Q$root_filename\E\.bbl\.$/m;open(my $o,q(>),qq($b.bbl)) or return;close $o;print qq(PaperWeave: no $root_filename.bbl, an empty one stands in.\n);}`;

// latexmk runs with -norc, so a project's latexmkrc is never read and latexmk has no rules for
// glossaries or nomenclature. These are our own, passed with -e (which -norc does not stop).
// Shared by the build and by the command in a revision's download, so both make the same PDF.
//
// Rules, as latexmk custom dependencies:
//   .glo -> .gls, .acn -> .acr, .slo -> .sls   makeglossaries (glossaries)
//   .nlo -> .nls                               makeindex with nomencl.ist (nomencl), or
//                                              makeglossaries when the .aux has \@istfilename:
//                                              then the .nlo is glossaries' `numbers` glossary
// Every command is run by list-form system(), so no shell reads a file name. The string holds
// no single quote: it is put inside '...' in a shell command.
export const LATEXMK_RULES = String.raw`add_cus_dep(q(glo),q(gls),0,q(pw_gls));add_cus_dep(q(acn),q(acr),0,q(pw_gls));add_cus_dep(q(slo),q(sls),0,q(pw_gls));add_cus_dep(q(nlo),q(nls),0,q(pw_nlo));sub pw_gls{my($b,$p)=fileparse($_[0]);return system(q(makeglossaries),q(-d),$p,$b);}sub pw_nlo{my $a=qq($_[0].aux);if(open(my $h,q(<),$a)){local $/;my $t=<$h>;close $h;return pw_gls(@_) if $t=~/\\[@]istfilename/;}return system(q(makeindex),q(-s),q(nomencl.ist),q(-t),qq($_[0].nlg),q(-o),qq($_[0].nls),qq($_[0].nlo));}`;

-- Who decided a proposal, when it came in with a review file and that person has no account here.
alter table proposals add column imported_decider text;

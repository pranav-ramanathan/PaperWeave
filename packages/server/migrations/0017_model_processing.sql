-- Whether a paper's text may be sent to a model provider for a review. Off unless the paper's
-- owner turns it on.
alter table projects add column model_processing boolean not null default false;

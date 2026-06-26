-- Work result, orthogonal to the orchestration verdict.
--
-- `verdict` answers "how did the ORCHESTRATION end" (accepted / rejected /
-- failed_force_closed). It conflates two things an operator needs apart: a
-- task whose code is green but whose orchestration was force-closed reads as
-- `failed_force_closed`, which looks like the work failed when it did not.
--
-- `work_result` is the generic, domain-blind WORK signal the kernel can own
-- from the findings ledger alone:
--   clean   — no open blocking CODE finding remains (harness blockers, which
--             are plumbing failures rather than facts about the work, do not
--             count).
--   blocked — at least one open blocking code finding remains.
--   unknown — not yet evaluated (the column stays NULL until a terminal
--             boundary computes it).
--
-- Computed once at each terminal boundary (finalize / force-close / abandon)
-- from the live findings. A reader can now show e.g. "force_closed (work:
-- clean)" instead of a bare "failed".

ALTER TABLE pipeline_state
  ADD COLUMN work_result TEXT
  CHECK (work_result IS NULL OR work_result IN ('clean', 'blocked', 'unknown'));

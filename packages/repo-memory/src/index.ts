// Public barrel for `@loomfsm/repo-memory` — persistent, model-agnostic
// structural memory of a code repository.
//
// The dominant cost of a planning run is the planner cold-reading the whole
// tree every time — same project, consecutive tasks — to satisfy its mandatory
// `file:line` citation rule. This package builds a plain-markdown structural
// brief that PERSISTS across runs under loom's footprint and delta-refreshes per
// file via a content-hash table, so any model/backend can warm-start from it and
// cite structure instead of re-reading.
//
// It is AMBIENT TRANSPORT, outside the kernel's replay graph: wall-clock and git
// are used freely here, no NowToken is minted to build or read the brief, and
// every failure path degrades rather than throwing. The kernel never depends on
// this package; a transport (the CLI) calls `ensureBrief` and seeds the result
// into the agent sandbox.

export {
  ensureBrief,
  repoBriefEnabled,
  repoBriefPath,
  projectMemoryDir,
  projectHash,
} from "./repo-brief.js";
export type { BriefStats, EnsureBriefOptions } from "./repo-brief.js";

export {
  extractFile,
  langOf,
  shouldExtract,
  renderBrief,
} from "./repo-brief-extract.js";
export type {
  ExtractedSymbol,
  FileEntry,
  StackFacts,
  RenderInput,
  RenderResult,
} from "./repo-brief-extract.js";

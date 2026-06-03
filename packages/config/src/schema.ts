// Zod schemas for the control-layer documents — the single validation surface
// for every store. A malformed file surfaces a clear, located error rather than
// silently mis-parsing; the same schemas will feed a `GET /config/schema` and
// schema-driven forms in later phases (the reason we adopt a real validator now
// rather than hand-rolled checks).
//
// Zod is a dependency of THIS leaf only. It is never added to `@loomfsm/kernel`
// (whose zero-runtime-dep posture is load-bearing) — the kernel keeps its
// hand-rolled validators.
//
// Parsing is lenient on UNKNOWN keys at the document level (zod's default strips
// them) so a config written by a newer loom does not break an older reader;
// typo protection for hand edits lives in the `config set` verb's key allowlist,
// not here.

import { z } from "zod";

import type {
  LoomConfig,
  SecretsFile,
  WorkspaceEntry,
} from "./types.js";

const ModelRefSchema = z.string().min(1);

const BundleModelConfigSchema = z.object({
  agents: z.record(z.string(), ModelRefSchema).optional(),
});

const NotifyConfigSchema = z.object({
  webhook_url: z.string().optional(),
  slack_url: z.string().optional(),
  telegram_token: z.string().optional(),
  telegram_chat: z.string().optional(),
  script: z.string().optional(),
  events: z.array(z.string()).optional(),
  timeout_ms: z.number().int().nonnegative().optional(),
});

const ResilienceConfigSchema = z.object({
  rate_limit_wait: z.string().optional(),
  drive_deadline_ms: z.number().int().nonnegative().optional(),
  spawn_session_timeout_ms: z.number().int().nonnegative().optional(),
  spawn_idle_timeout_ms: z.number().int().nonnegative().optional(),
});

const BackendCredentialConfigSchema = z.object({
  key_ref: z.string().optional(),
  base_url_ref: z.string().optional(),
});

export const LoomConfigSchema = z.object({
  backend: z.string().min(1).optional(),
  bundles: z.record(z.string(), BundleModelConfigSchema).optional(),
  notify: NotifyConfigSchema.optional(),
  resilience: ResilienceConfigSchema.optional(),
  credentials: z.record(z.string(), BackendCredentialConfigSchema).optional(),
});

export const SecretsFileSchema = z.record(z.string(), z.string());

const WorkspaceEntrySchema = z.object({
  id: z.string().min(1),
  dir: z.string().min(1),
  label: z.string().optional(),
  bundle: z.string().optional(),
  added_at: z.string().optional(),
  last_opened_at: z.string().optional(),
  pinned: z.boolean().optional(),
});

export const WorkspaceFileSchema = z.object({
  projects: z.array(WorkspaceEntrySchema),
});

// Parse a document or throw a clear, sourced error. `label` names the file in
// the message so a hand-editor knows which store failed.
export function parseLoomConfig(raw: unknown, label: string): LoomConfig {
  const result = LoomConfigSchema.safeParse(raw);
  if (!result.success) throw schemaError(label, result.error);
  return result.data;
}

export function parseSecretsFile(raw: unknown, label: string): SecretsFile {
  const result = SecretsFileSchema.safeParse(raw);
  if (!result.success) throw schemaError(label, result.error);
  return result.data;
}

export function parseWorkspaceFile(raw: unknown, label: string): WorkspaceEntry[] {
  const result = WorkspaceFileSchema.safeParse(raw);
  if (!result.success) throw schemaError(label, result.error);
  return result.data.projects;
}

function schemaError(label: string, error: z.ZodError): Error {
  const first = error.issues[0];
  const where =
    first !== undefined && first.path.length > 0 ? ` at '${first.path.join(".")}'` : "";
  const why = first !== undefined ? first.message : "invalid shape";
  return new Error(`invalid loom config (${label})${where}: ${why}`);
}

import type { ProjectStatus } from "./types.js";

export type StatusTone = "idle" | "ok" | "warn" | "bad";

export interface StatusBadge {
  tone: StatusTone;
  label: string;
}

// Collapse a read-model status into a single operator-facing badge — the same
// signals `loom status` surfaces, domain-blind (it reads only generic FSM
// fields, never the bundle's gate meaning). Pure, so it is unit-testable
// without a DOM.
export function statusBadge(s: ProjectStatus | null | undefined): StatusBadge {
  if (!s || !s.has_task) return { tone: "idle", label: "idle" };
  if (s.parked_gate) return { tone: "warn", label: `parked: ${s.parked_gate.gate}` };
  if (s.stalled) return { tone: "bad", label: "stalled" };
  if (s.status === "in_progress") {
    const n = s.pending_agents.length;
    return { tone: "ok", label: n > 0 ? `running · ${n} pending` : "running" };
  }
  if (s.status === "completed") {
    return { tone: s.verdict === "rejected" ? "warn" : "ok", label: s.verdict ?? "completed" };
  }
  if (s.status === "abandoned") return { tone: "bad", label: "abandoned" };
  return { tone: "idle", label: s.status ?? "idle" };
}

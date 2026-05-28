// Stage-union validators — rules 2-6 + 8 of the bundle-loader cascade.
//
// `validateStages` walks `bundle.stages` and refuses any structural
// deviation the FSM relies on at runtime: unknown kind, key/name
// mismatch, dangling agent reference, unknown stage referenced by a
// flow, unknown phase, and the cross-stage `StepStage.effects[]`
// collision check.

import { KernelError } from "../../state/db.js";
import type { Bundle } from "../../types/bundle.js";
import type { Stage, StepStage } from "../../types/plugins.js";

const KNOWN_STAGE_KINDS: ReadonlySet<string> = new Set([
  "spawn",
  "fanout",
  "gate",
  "step",
  "finalize",
]);

export function validateStages(bundle: Bundle): void {
  const stageEntries = Object.entries(bundle.stages);
  const agentNames = new Set(bundle.agents.map((a) => a.name));
  const phaseSet = new Set<string>(bundle.phases);
  const stageKeys = new Set(stageEntries.map(([k]) => k));

  // 2. BUNDLE_STAGE_UNKNOWN_KIND
  for (const [key, stage] of stageEntries) {
    const kind = (stage as { kind?: unknown }).kind;
    if (typeof kind !== "string" || !KNOWN_STAGE_KINDS.has(kind)) {
      throw new KernelError({
        code: "BUNDLE_STAGE_UNKNOWN_KIND",
        message: `stage '${key}' has unknown kind '${String(kind)}'`,
        detail: { stage: key, kind },
      });
    }
  }

  // 3. BUNDLE_STAGE_NAME_MISMATCH
  for (const [key, stage] of stageEntries) {
    if (stage.name !== key) {
      throw new KernelError({
        code: "BUNDLE_STAGE_NAME_MISMATCH",
        message: `stage map key '${key}' disagrees with stage.name '${stage.name}'`,
        detail: { key, name: stage.name },
      });
    }
  }

  // 4. BUNDLE_AGENT_UNKNOWN
  for (const [key, stage] of stageEntries) {
    if (stage.kind === "spawn") {
      if (!agentNames.has(stage.agent)) {
        throw new KernelError({
          code: "BUNDLE_AGENT_UNKNOWN",
          message: `spawn stage '${key}' references unknown agent '${stage.agent}'`,
          detail: { stage: key, agent: stage.agent },
        });
      }
    } else if (stage.kind === "fanout") {
      for (const a of stage.agents) {
        if (!agentNames.has(a)) {
          throw new KernelError({
            code: "BUNDLE_AGENT_UNKNOWN",
            message: `fanout stage '${key}' references unknown agent '${a}'`,
            detail: { stage: key, agent: a },
          });
        }
      }
    }
  }

  // 5. BUNDLE_FLOW_UNKNOWN_STAGE
  for (const [flowName, flowEntries] of Object.entries(bundle.flows)) {
    for (const entry of flowEntries) {
      if (!stageKeys.has(entry)) {
        throw new KernelError({
          code: "BUNDLE_FLOW_UNKNOWN_STAGE",
          message: `flow '${flowName}' references unknown stage '${entry}'`,
          detail: { flow: flowName, missing_stage: entry },
        });
      }
    }
  }
  if (!Object.prototype.hasOwnProperty.call(bundle.flows, bundle.default_flow)) {
    throw new KernelError({
      code: "BUNDLE_FLOW_UNKNOWN_STAGE",
      message: `default_flow '${bundle.default_flow}' is not a registered flow`,
      detail: { default_flow: bundle.default_flow },
    });
  }

  // 6. BUNDLE_PHASE_UNKNOWN — non-finalize stages with a phase declared
  //    must name a phase the bundle ships. FinalizeStage has no phase
  //    field; StepStage.phase is optional and is checked only when set.
  for (const [key, stage] of stageEntries) {
    if (stage.kind === "finalize") continue;
    const phase = (stage as { phase?: string }).phase;
    if (phase === undefined) continue;
    if (!phaseSet.has(phase)) {
      throw new KernelError({
        code: "BUNDLE_PHASE_UNKNOWN",
        message: `stage '${key}' declares phase '${phase}' which is not in bundle.phases`,
        detail: { stage: key, phase },
      });
    }
  }

  // 8. STEP_EFFECT_COLLISION — two distinct StepStages cannot declare
  //    the same effect target (kind + discriminant value).
  validateStepEffectCollisions(stageEntries);
}

function effectKey(eff: StepStage["effects"][number]): string {
  switch (eff.kind) {
    case "state.write":
      return `state.write:${eff.field}`;
    case "decisions.set":
      return `decisions.set:${eff.key}`;
    case "bundle_state.set":
      return `bundle_state.set:${eff.path}`;
    case "finding.insert":
      return `finding.insert:${eff.phase}`;
    case "audit.emit":
      return `audit.emit:${eff.type}`;
  }
}

function validateStepEffectCollisions(stageEntries: [string, Stage][]): void {
  const seen = new Map<string, string>();
  for (const [key, stage] of stageEntries) {
    if (stage.kind !== "step") continue;
    for (const eff of stage.effects) {
      const ek = effectKey(eff);
      const prior = seen.get(ek);
      if (prior !== undefined && prior !== key) {
        throw new KernelError({
          code: "STEP_EFFECT_COLLISION",
          message: `step '${key}' and step '${prior}' both declare effect '${ek}'`,
          detail: { effect: ek, stages: [prior, key] },
        });
      }
      seen.set(ek, key);
    }
  }
}

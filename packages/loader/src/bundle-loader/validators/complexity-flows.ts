// complexity_flows validator — the shared-prefix invariant for
// complexity-driven flow selection.
//
// The kernel re-selects the active flow ONCE, at the boundary right after
// `after_stage`, keyed on `decisions[decision_key]`. For `step_index` to
// stay aligned across that switch, every candidate flow (the `map` targets
// PLUS `default_flow`, the pre-switch flow) must share an identical prefix
// up to and including `after_stage`. This validator refuses a mis-authored
// map at LOAD so a prefix break fails at kernel start, never mid-run.

import { KernelError } from "@loomfsm/kernel";
import type { Bundle } from "@loomfsm/kernel";

export function validateComplexityFlows(bundle: Bundle): void {
  const cf = bundle.complexity_flows;
  if (cf === undefined) return;

  if (typeof cf.decision_key !== "string" || cf.decision_key.length === 0) {
    throw new KernelError({
      code: "COMPLEXITY_FLOW_DECISION_KEY_INVALID",
      message: "complexity_flows.decision_key must be a non-empty string",
      detail: { decision_key: cf.decision_key },
    });
  }

  const defaultFlow = bundle.flows[bundle.default_flow];
  if (defaultFlow === undefined) {
    // default_flow itself is validated by validateStages; guard defensively.
    throw new KernelError({
      code: "COMPLEXITY_FLOW_AFTER_STAGE_UNKNOWN",
      message: `complexity_flows references default_flow '${bundle.default_flow}' which is not a registered flow`,
      detail: { default_flow: bundle.default_flow },
    });
  }

  const switchIndex = defaultFlow.indexOf(cf.after_stage);
  if (switchIndex < 0) {
    throw new KernelError({
      code: "COMPLEXITY_FLOW_AFTER_STAGE_UNKNOWN",
      message: `complexity_flows.after_stage '${cf.after_stage}' is not in default_flow '${bundle.default_flow}'`,
      detail: { after_stage: cf.after_stage, default_flow: bundle.default_flow },
    });
  }

  // The prefix that every candidate flow must agree on: indices
  // [0 .. switchIndex] inclusive (up to AND including after_stage).
  const requiredPrefix = defaultFlow.slice(0, switchIndex + 1);

  for (const [value, flowName] of Object.entries(cf.map)) {
    const candidate = bundle.flows[flowName];
    if (candidate === undefined) {
      throw new KernelError({
        code: "COMPLEXITY_FLOW_UNKNOWN",
        message: `complexity_flows maps '${value}' to flow '${flowName}' which is not a registered flow`,
        detail: { value, flow: flowName },
      });
    }
    if (!sharesPrefix(candidate, requiredPrefix)) {
      throw new KernelError({
        code: "COMPLEXITY_FLOW_PREFIX_MISMATCH",
        message:
          `complexity_flows flow '${flowName}' (for '${value}') does not share the prefix ` +
          `[${requiredPrefix.join(", ")}] up to after_stage '${cf.after_stage}' — ` +
          `switching to it would misalign step_index`,
        detail: { value, flow: flowName, required_prefix: requiredPrefix },
      });
    }
  }
}

function sharesPrefix(flow: string[], prefix: string[]): boolean {
  if (flow.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (flow[i] !== prefix[i]) return false;
  }
  return true;
}

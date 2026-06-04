import { defineManifest } from "@loomfsm/kernel";

export default defineManifest({
  manifest_version: "1.0",
  name: "code",
  display_name: "Code review & implementation bundle",
  description:
    "Multi-agent code-review / implementation flow — classifier, planner, reviewer fanout, gate, and finalize.",
  version: "3.1.0",
  kind: "bundle",
  publisher: "@loom",
  // What this bundle's runtime structure actually demands. The loader
  // refuses any observable behavior the manifest does not declare; this
  // list grows in lockstep as the bundle grows. The load-enforced entries
  // here are `hook.side_effect` (post-commit observers) and
  // `invariant.bundle` (domain + safety-floor rules). The state.write /
  // fs / shell entries document the surfaces the bundle's steps and agents
  // use; shell.exec.sandboxed is the seam the deterministic lint / test /
  // typecheck writers plug into when a deployment enables an auto final
  // gate. No event-position Steps and no migrations directory ship today,
  // so `stage.event` and `migration.bundle` are intentionally absent.
  capabilities: [
    "state.read",
    "state.write.decisions",
    "state.write.bundle_state",
    "state.write.findings",
    "state.write.gates",
    "state.write.agent_verdicts",
    "fs.read.project",
    "shell.exec.sandboxed",
    "hook.side_effect",
    "invariant.bundle",
  ],
  requires: { kernel_api: "^3.0" },
});

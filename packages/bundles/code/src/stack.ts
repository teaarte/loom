// StackInfo — the code bundle's build-stack descriptor.
//
// A build stack (language, package manager, test/lint/build commands,
// project shape) is a code-domain concept the SUBSTRATE never names. The
// classifier agent picks these fields from `stack-candidates.yaml` and emits
// them in its result header; the kernel's generic decisions-merge lands the
// object in `decisions.stack`, and the bundle's `stack-to-bundle-state` step
// relocates it to the bundle-owned `bundle_state.stack` slot that downstream
// agents — and, ahead, the sandboxed executor — read. The shape lives here,
// in the bundle, not in the kernel: the kernel only ever sees an opaque blob.
export interface StackInfo {
  language: string;
  package_manager: string | null;
  test_command: string | null;
  lint_command: string | null;
  build_command: string | null;
  project_type: "frontend-app" | "backend" | "library" | "monorepo" | null;
}

// Narrow an unknown decisions value to a StackInfo-shaped object. The
// classifier emits a JSON object (or null); this guards the relocate step
// against a non-object before it is written to bundle_state. Deliberately
// structural-lenient — the bundle owns the contract, the kernel does not
// validate it — so a forward-compatible classifier adding fields still passes.
export function isStackInfo(value: unknown): value is StackInfo {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

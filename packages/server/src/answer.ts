// `answerGate` — the deliver-a-human-answer path behind
// `POST /projects/:id/answer`.
//
// It is the network equivalent of `/proceed`: the same `deliverAndAdvance`
// composition the stdio `pipeline_continue_task` tool uses, fed a `user-answer`
// input. The parked supervisor watcher is polling the generic
// `pending_user_answer` slot; once this delivery clears it, the watcher's
// `waitForWake` returns and the supervisor re-`drive()`s past the gate. So the
// HTTP layer never drives — it only delivers; supervision stays the watcher's
// job (intake and supervision are separate layers over one store).
//
// Domain-blind: it carries the operator's generic decision (accept / reject /
// auto-apply + an optional revise/abandon intent + a free-text message) and
// the gate's event id straight to the kernel, which binds the answer to the
// exact gate event (a mismatched id is refused as stale). It never interprets
// what the gate means.

import { deliverAndAdvance, readState } from "@loomfsm/driver";
import { peekArchiveSlot, type Registry } from "@loomfsm/kernel";

import { fromKernelError, ServerError } from "./errors.js";

const DECISIONS = new Set(["accept", "reject", "auto-apply"]);
const REJECT_INTENTS = new Set(["revise", "abandon"]);

export interface AnswerArgs {
  gate_event_id: string;
  decision: "accept" | "reject" | "auto-apply";
  reject_intent?: "revise" | "abandon";
  message?: string;
}

export interface AnswerResult {
  // The next directive's wire status after the answer advanced the FSM.
  status: string;
}

// Validate an untrusted answer body into typed `AnswerArgs`, or throw a 400.
export function parseAnswer(body: Record<string, unknown>): AnswerArgs {
  const gateEventId = body["gate_event_id"];
  if (typeof gateEventId !== "string" || gateEventId.length === 0) {
    throw new ServerError("ANSWER_INVALID", 400, "gate_event_id is required");
  }
  const decision = body["decision"];
  if (typeof decision !== "string" || !DECISIONS.has(decision)) {
    throw new ServerError(
      "ANSWER_INVALID",
      400,
      "decision must be one of accept | reject | auto-apply",
    );
  }
  const rejectIntent = body["reject_intent"];
  if (rejectIntent !== undefined && (typeof rejectIntent !== "string" || !REJECT_INTENTS.has(rejectIntent))) {
    throw new ServerError("ANSWER_INVALID", 400, "reject_intent must be revise | abandon");
  }
  const message = body["message"];
  if (message !== undefined && typeof message !== "string") {
    throw new ServerError("ANSWER_INVALID", 400, "message must be a string");
  }
  return {
    gate_event_id: gateEventId,
    decision: decision as AnswerArgs["decision"],
    ...(rejectIntent !== undefined ? { reject_intent: rejectIntent as "revise" | "abandon" } : {}),
    ...(message !== undefined ? { message } : {}),
  };
}

export async function answerGate(
  projectDir: string,
  registry: Registry,
  args: AnswerArgs,
): Promise<AnswerResult> {
  const slot = await peekArchiveSlot(projectDir);
  if (slot === null) {
    throw new ServerError("NO_ACTIVE_TASK", 404, "no active task to answer");
  }

  const state = await readState(projectDir);
  if (state.driver.pending_user_answer === null) {
    throw new ServerError("NO_PARKED_GATE", 409, "the task is not parked on a human gate");
  }

  try {
    const { response } = await deliverAndAdvance(projectDir, {
      registry,
      driver_state_id: state.driver_state_id,
      input: {
        type: "user-answer",
        gate_event_id: args.gate_event_id,
        decision: args.decision,
        ...(args.reject_intent !== undefined ? { reject_intent: args.reject_intent } : {}),
        ...(args.message !== undefined ? { message: args.message } : {}),
      },
    });
    return { status: response.status };
  } catch (err) {
    throw fromKernelError(err);
  }
}

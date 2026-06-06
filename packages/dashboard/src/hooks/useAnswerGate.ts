import { useState } from "react";

import { api, errText } from "../lib/api.js";

export interface AnswerInput {
  gateEventId: string;
  decision: "accept" | "reject" | "auto-apply";
  rejectIntent?: "revise" | "abandon";
  message?: string;
}

export interface AnswerGateState {
  busy: boolean;
  msg: string | null;
  // Resolves true when the answer was delivered (so the form can clear its
  // optional-message field only on success), false on a refusal.
  answer: (input: AnswerInput) => Promise<boolean>;
}

// Deliver a human answer to a parked gate — a PEER of `loom resume`, posting to
// `POST /projects/:id/answer`. Carries the generic decision (accept / reject /
// auto-apply) + an optional message; it never interprets WHAT the gate means
// (that is the bundle's). Owns the async + busy/message state.
export function useAnswerGate(projectId: string): AnswerGateState {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const answer = async (input: AnswerInput): Promise<boolean> => {
    setBusy(true);
    setMsg(null);
    try {
      await api("POST", `/projects/${encodeURIComponent(projectId)}/answer`, {
        gate_event_id: input.gateEventId,
        decision: input.decision,
        ...(input.decision === "reject" && input.rejectIntent !== undefined
          ? { reject_intent: input.rejectIntent }
          : {}),
        ...(input.message !== undefined && input.message.trim().length > 0
          ? { message: input.message.trim() }
          : {}),
      });
      setMsg("delivered");
      return true;
    } catch (err) {
      setMsg(errText(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return { busy, msg, answer };
}

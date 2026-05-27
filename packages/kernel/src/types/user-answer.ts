// Gate reply protocol — what humans (or the auto-policy dispatcher) send
// back when answering an ask-user.

export type UserDecision = "accept" | "reject" | "auto-apply";
export type RejectIntent = "revise" | "abandon";

export interface UserAnswer {
  decision: UserDecision;
  reject_intent?: RejectIntent;
  message?: string;
}

// Structured description of what answers the kernel will accept on a
// gate. Skill markdown / daemon UI render this verbatim and never
// encode gate-name vocabulary themselves.
export interface UserAnswerSchema {
  options: UserAnswerOption[];
}

export interface UserAnswerOption {
  verbs: string[];
  label: string;
  produces: {
    decision: UserDecision;
    reject_intent?: RejectIntent;
    requires_message?: boolean;
  };
}

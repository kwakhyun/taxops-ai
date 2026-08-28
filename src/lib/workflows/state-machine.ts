export const workflowStates = [
  "INTAKE",
  "RETRIEVE",
  "DRAFT",
  "VERIFY",
  "AWAITING_REVIEW",
  "APPROVED",
  "REJECTED",
  "FAILED",
] as const;

export type WorkflowState = (typeof workflowStates)[number];

const transitions: Record<WorkflowState, ReadonlySet<WorkflowState>> = {
  INTAKE: new Set(["RETRIEVE", "FAILED"]),
  RETRIEVE: new Set(["DRAFT", "FAILED"]),
  DRAFT: new Set(["VERIFY", "FAILED"]),
  VERIFY: new Set(["DRAFT", "AWAITING_REVIEW", "FAILED"]),
  AWAITING_REVIEW: new Set(["APPROVED", "REJECTED"]),
  APPROVED: new Set(),
  REJECTED: new Set(["DRAFT"]),
  FAILED: new Set(["INTAKE"]),
};

export class InvalidWorkflowTransitionError extends Error {
  constructor(from: WorkflowState, to: WorkflowState) {
    super(`Invalid workflow transition: ${from} -> ${to}`);
    this.name = "InvalidWorkflowTransitionError";
  }
}

export function canTransition(from: WorkflowState, to: WorkflowState) {
  return transitions[from].has(to);
}

export function transition(from: WorkflowState, to: WorkflowState) {
  if (!canTransition(from, to))
    throw new InvalidWorkflowTransitionError(from, to);
  return to;
}

export function isExternallyPublishable(state: WorkflowState) {
  return state === "APPROVED";
}

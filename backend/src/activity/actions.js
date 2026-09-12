// Canonical labels for case_activity_log.action / .target_type. Plain string
// constants (text column, not a pgEnum) so adding an action never needs a
// migration — same rationale as src/audit/actions.js.
export const CaseActivityAction = Object.freeze({
  COMMENT_CREATED: "COMMENT_CREATED",
  COMMENT_EDITED: "COMMENT_EDITED",
  COMMENT_DELETED: "COMMENT_DELETED",
});

export const ActivityTargetType = Object.freeze({
  COMMENT: "COMMENT",
});

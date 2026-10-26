import { defineNoticeKind } from "../registry.mjs";

export const intakeCandidatesNotice = defineNoticeKind({
  id: "intake-candidates",
  marker: "[候选]",
  instructions: "candidate-rules.md",
  actions: {},
  render(payload) {
    return String(payload.text ?? "");
  },
});

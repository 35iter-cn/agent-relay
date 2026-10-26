import { defineNoticeKind } from "../registry.mjs";

export const plainNotice = defineNoticeKind({
  id: "plain",
  marker: null,
  prompt: "notice.md",
  actions: {},
  render(payload) {
    return String(payload.text ?? "");
  },
});

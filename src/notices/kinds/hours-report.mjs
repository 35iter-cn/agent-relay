import { defineNoticeKind } from "../registry.mjs";

export const hoursReportNotice = defineNoticeKind({
  id: "hours-report",
  marker: "工时",
  prompt: "notice.md",
  actions: {},
  render(payload) {
    return String(payload.text ?? "");
  },
});

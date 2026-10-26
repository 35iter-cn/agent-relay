import { defineNoticeKind } from "../registry.mjs";

export const bootNotice = defineNoticeKind({
  id: "boot",
  marker: "🟢 系统已启动",
  prompt: "notice.md",
  actions: {},
  render(payload) {
    return payload.text;
  },
});

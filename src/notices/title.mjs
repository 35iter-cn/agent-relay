export const NOTICE_TITLES = {
  boot: "启动",
  stall: "卡住",
  round: "播报",
  pause: "自动暂停",
  throttle: "限流",
  notice: "通知",
};

export const TITLE_MARK = "📣📣📣";

export function withTitle(title, text) {
  const label = String(title ?? "").trim() || NOTICE_TITLES.notice;
  const body = String(text ?? "").trim();
  const head = `${TITLE_MARK} ${label}`;
  return body ? `${head}\n${body}` : head;
}

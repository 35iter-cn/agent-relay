export const NOTICE_TITLES = {
  boot: "boot",
  stall: "stalled",
  round: "round",
  pause: "auto-paused",
  throttle: "throttled",
  notice: "notice",
  restart: "restart",
};

export const TITLE_MARK = "📣📣📣";

export function withTitle(title, text) {
  const label = String(title ?? "").trim() || NOTICE_TITLES.notice;
  const body = String(text ?? "").trim();
  const head = `${TITLE_MARK} ${label}`;
  return body ? `${head}\n${body}` : head;
}

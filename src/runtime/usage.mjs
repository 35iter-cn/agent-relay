import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ANSWER_HEAD_CHARS = 200;
const MAGIC_ANSWER_CHARS = 400;
const MAGIC_CONTEXT_CHARS = 1_500;

const LOCAL_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
const localDay = (ms) => LOCAL_DAY.format(new Date(ms));

export function usagePromptOf(source) {
  if (!source || typeof source !== "object") return null;
  const instructions = typeof source.instructions === "string" ? source.instructions.trim() : "";
  const criteria = source.criteria && typeof source.criteria === "object" ? source.criteria : null;
  if (!instructions || !criteria || !Object.keys(criteria).length) return null;
  return { instructions, criteria };
}

export function createUsage(deps = {}) {
  const clock = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  const dir = deps.dir;
  const judge = deps.judge ?? null;
  const prompt = usagePromptOf(deps.prompt);
  const write = deps.write ?? appendFileSync;

  function judgeState(job, answer) {
    const text = String(job?.inbound?.text ?? "");
    const root = String(job?.inbound?.rootText ?? "");
    const start = root && root !== text ? root.slice(0, MAGIC_CONTEXT_CHARS) : "(无，本级即话题起点)";
    return [
      `【话题起始消息】\n${start}`,
      `【本轮用户消息】\n${text}`,
      `【agent 本轮回答（仅供参考，不是用户请求）】\n${String(answer ?? "").slice(0, MAGIC_ANSWER_CHARS)}`,
    ].join("\n\n");
  }

  async function judgeMagic(job, answer) {
    if (!prompt) return { magic: "unconfigured", confidence: null, fallback: "no-prompt" };
    if (typeof judge?.judgeChoice !== "function") return { magic: "unknown", confidence: null, fallback: "nokey" };
    const verdict = await judge.judgeChoice({
      id: "run-magic",
      state: judgeState(job, answer),
      instructions: prompt.instructions,
      criteria: prompt.criteria,
    });
    return {
      magic: verdict.choice ?? "unknown",
      confidence: verdict.confidence ?? null,
      fallback: verdict.fallback ?? null,
    };
  }

  async function recordRun({ job, platform, key, session, answer, status, startedAt }) {
    try {
      const endedAt = clock();
      const beganAt = Number.isFinite(startedAt) ? startedAt : endedAt;
      const input = String(job?.inbound?.text ?? "");
      const output = String(answer ?? "");
      const judged = status === "done"
        ? await judgeMagic(job, output)
        : { magic: "unjudged", confidence: null, fallback: status };
      const record = {
        ts: new Date(endedAt).toISOString(),
        event: "usage",
        jobId: job?.id ?? null,
        platform,
        key,
        session,
        startedAt: new Date(beganAt).toISOString(),
        endedAt: new Date(endedAt).toISOString(),
        durationMs: endedAt - beganAt,
        status,
        inputChars: input.length,
        answerChars: output.length,
        magic: judged.magic,
        confidence: judged.confidence,
        fallback: judged.fallback,
      };
      if (status === "done") record.answerHead = output.slice(0, ANSWER_HEAD_CHARS);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      write(join(dir, `${localDay(endedAt)}.jsonl`), `${JSON.stringify(record)}\n`, { mode: 0o600 });
      return record;
    } catch (error) {
      log("warn", "usage", String(error?.message ?? error));
      return null;
    }
  }

  return { recordRun };
}

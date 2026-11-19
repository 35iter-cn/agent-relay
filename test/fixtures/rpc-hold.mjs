#!/usr/bin/env bun
// A real child that speaks just enough of the RPC protocol: it answers the
// handshake and the prompt, then stays silent so the relay keeps the round open.
// RPC_FIXTURE_ANSWER=<text> makes it answer and settle instead.
import { writeFileSync } from "node:fs";

const answer = process.env.RPC_FIXTURE_ANSWER ?? "";
const holdOn = process.env.RPC_FIXTURE_HOLD_ON ?? "";
const delayMs = Number(process.env.RPC_FIXTURE_DELAY_MS ?? 0);
const exitCode = Number(process.env.RPC_FIXTURE_EXIT ?? 0);
const session = process.env.RPC_FIXTURE_SESSION ?? null;
const out = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);

process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const ok = (data) => out({ id: record.id, type: "response", command: record.type, success: true, data });
    if (record.type === "get_state") {
      ok({ sessionId: session, messageCount: 0, isStreaming: false, pendingMessageCount: 0 });
      continue;
    }
    if (record.type === "prompt") {
      ok({ disposition: "started" });
      const text = typeof record.message === "string" ? record.message : String(record.message?.text ?? "");
      if (holdOn && text.includes(holdOn)) continue;
      if (!answer) continue;
      const emit = () => {
        out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }], stopReason: "final" } });
        out({ type: "agent_settled", aborted: false });
        if (exitCode) process.exit(exitCode);
      };
      if (delayMs > 0) setTimeout(emit, delayMs);
      else emit();
      continue;
    }
    if (record.type === "steer") {
      ok({ disposition: "queued" });
      continue;
    }
    ok({});
  }
});
setInterval(() => {}, 1_000);
process.stdin.on("end", () => process.exit(0));

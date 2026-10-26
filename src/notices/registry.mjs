import { bootNotice } from "./kinds/boot.mjs";
import { hoursReportNotice } from "./kinds/hours-report.mjs";
import { intakeCandidatesNotice } from "./kinds/intake-candidates.mjs";
import { jobStallNotice } from "./kinds/job-stall.mjs";
import { plainNotice } from "./kinds/plain.mjs";

const KINDS = [jobStallNotice, intakeCandidatesNotice, hoursReportNotice, bootNotice, plainNotice];

export function defineNoticeKind(kind) {
  if (!kind || typeof kind.id !== "string" || !kind.id) throw new Error("notice kind needs an id");
  if (typeof kind.render !== "function") throw new Error(`notice kind ${kind.id} needs render()`);
  const actions = kind.actions ?? {};
  for (const [name, spec] of Object.entries(actions)) {
    if (!spec || typeof spec.help !== "string") throw new Error(`notice kind ${kind.id} action ${name} needs help`);
  }
  return { prompt: "notice.md", instructions: null, marker: null, actions, ...kind };
}

export function createRegistry(kinds = KINDS) {
  const byId = new Map(kinds.map((kind) => [kind.id, defineNoticeKind(kind)]));
  return {
    get(id) {
      const kind = byId.get(id);
      if (!kind) throw new Error(`unknown notice kind: ${id}`);
      return kind;
    },
    has(id) {
      return byId.has(id);
    },
    all() {
      return [...byId.values()];
    },
  };
}

export const registry = createRegistry();

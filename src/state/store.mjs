import { readJson, writeJsonAtomic } from "../shared/json.mjs";
import { emptyState, SCHEMA_VERSION, upgradeState } from "./schema.mjs";

export function createStateStore({ file, log = () => {} }) {
  const loaded = readJson(file, null);
  const needsUpgrade = !loaded?.meta?.schemaVersion;
  const state = upgradeState(loaded ?? emptyState());
  const save = () => writeJsonAtomic(file, state);
  if (needsUpgrade) {
    try {
      save();
    } catch (error) {
      log("warn", "state-save", String(error?.message ?? error));
    }
  }
  return { state, save, file, schemaVersion: SCHEMA_VERSION };
}

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig } from "./config";
import { parseApiSettings } from "../api/settings";
import { readSkillStorageSettings } from "./skill-storage-settings";

export function readNodeApiSettings() {
  if (process.env.API_SETTINGS) {
    try { return parseApiSettings(JSON.parse(process.env.API_SETTINGS)); }
    catch { throw new Error("API settings are unavailable or invalid."); }
  }
  const local = readConfig();
  const source = JSON.parse(readFileSync(process.env.API_CONFIG_FILE ?? resolve("../ax-local/.state/auth/api.json"), "utf8"));
  const { caPath, ...database } = source.database;
  const versions = JSON.parse(readFileSync(new URL("../../ax-local/versions.json", import.meta.url), "utf8"));
  const storagePath = process.env.SKILL_STORAGE_CONFIG_FILE ?? resolve("../ax-local/.state/object-storage/api.env");
  const skillStorage = process.env.SKILL_STORAGE_CONFIG_FILE || existsSync(storagePath) ? readSkillStorageSettings(storagePath) : undefined;
  return parseApiSettings({ apiOrigin: local.apiOrigin, apiToken: local.apiToken,
    identity: { issuer: source.issuer, clientId: source.clientId, audience: source.audience },
    database: { ...database, ca: caPath ? readFileSync(caPath, "utf8") : null },
    image: process.env.RUNNER_IMAGE ?? versions.runner_task, skillStorage });
}

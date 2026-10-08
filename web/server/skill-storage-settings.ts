import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { skillStorageSettingsSchema } from "../api/settings";

export function readSkillStorageSettings(path: string) {
  try {
    const env = parseEnv(readFileSync(path, "utf8"));
    const flag = (name: string) => {
      const value = env[`APP_SKILL_STORAGE_${name}`];
      if (value !== "true" && value !== "false") throw new Error();
      return value === "true";
    };
    return skillStorageSettingsSchema.parse({
      endpoint: env.APP_SKILL_STORAGE_ENDPOINT, bucket: env.APP_SKILL_STORAGE_BUCKET,
      region: env.APP_SKILL_STORAGE_REGION, forcePathStyle: flag("FORCE_PATH_STYLE"),
      accessKeyId: env.APP_SKILL_STORAGE_ACCESS_KEY_ID, secretAccessKey: env.APP_SKILL_STORAGE_SECRET_ACCESS_KEY,
      storeId: env.APP_SKILL_STORAGE_STORE_ID, allowInsecureHttp: flag("ALLOW_INSECURE_HTTP"),
    });
  } catch { throw new Error("Skill storage settings are unavailable or invalid."); }
}

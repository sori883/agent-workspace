import { readAuthConfig } from "../server/auth-config";
import { createPool } from "../server/auth-store";
import { migrateData } from "../server/data-migrate";

const pool = createPool(readAuthConfig());
try { await migrateData(pool); console.info("Application schema is ready; admission remains closed until migration verification."); }
catch { console.error("Application migration failed. Existing data was not replaced."); process.exitCode = 1; }
finally { await pool.end(); }

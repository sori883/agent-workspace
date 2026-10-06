import { readAuthConfig } from "../server/auth-config";
import { createPool } from "../server/auth-store";
import { migrateAuth } from "../server/auth-migrate";

const pool = createPool(readAuthConfig());
try { await migrateAuth(pool); console.info("Authentication database is ready."); }
catch { console.error("Authentication database migration failed. Check the connection and schema."); process.exitCode = 1; }
finally { await pool.end(); }

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool } from "./pool.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runMigrations(): Promise<void> {
  const pool = getPool();
  const sqlPath = join(__dirname, "migrations", "001_initial.sql");
  const sql = await readFile(sqlPath, "utf8");
  await pool.query(sql);
}

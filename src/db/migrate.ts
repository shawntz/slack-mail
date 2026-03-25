import { config as loadEnv } from "dotenv";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

loadEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: url });
  const sqlPath = join(__dirname, "migrations", "001_initial.sql");
  const sql = await readFile(sqlPath, "utf8");
  await pool.query(sql);
  console.log("Migrations applied.");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

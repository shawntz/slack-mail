import pg from "pg";
import { getConfig } from "../config.js";

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({ connectionString: getConfig().DATABASE_URL });
  }
  return pool;
}

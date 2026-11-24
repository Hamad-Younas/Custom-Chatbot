import mysql from "mysql2/promise";
import { env } from "../config/env.js";

export const pool = mysql.createPool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  connectionLimit: env.DB_CONNECTION_LIMIT,
  waitForConnections: true,
  timezone: "Z", // every DATETIME is UTC
  charset: "utf8mb4_unicode_ci",
  supportBigNumbers: true,
  dateStrings: false,
  decimalNumbers: true,
  ssl: env.DB_SSL ? { rejectUnauthorized: true } : undefined,
  enableKeepAlive: true,
});

// The schema stores all DATETIME values in UTC.
pool.on("connection", (conn) => {
  conn.query("SET time_zone = '+00:00'");
});

/** Run a query and return rows (SELECT) or the result header (INSERT/UPDATE). */
export async function query(sql, params = [], conn = pool) {
  const [rows] = await conn.query(sql, params);
  return rows;
}

/** First row or null. */
export async function one(sql, params = [], conn = pool) {
  const rows = await query(sql, params, conn);
  return rows[0] ?? null;
}

/** Run fn inside a transaction; commits on success, rolls back on error. */
export async function tx(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (e) {
    try {
      await conn.rollback();
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    conn.release();
  }
}

/** MariaDB JSON columns are LONGTEXT: parse safely. */
export function j(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object" && !Buffer.isBuffer(value)) return value;
  try {
    return JSON.parse(value.toString());
  } catch {
    return fallback;
  }
}

export const toJson = (v) => (v === undefined || v === null ? null : JSON.stringify(v));

export async function pingDb() {
  await pool.query("SELECT 1");
}

// Creates the database (runs database/chatbot_platform_schema.sql) and applies database/migrations/*.sql.
// Usage:  npm run db:setup         (reads DB_* from backend/.env)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import "dotenv/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const dbDir = path.resolve(here, "../../database");
const DB = process.env.DB_NAME || "chatbot_saas";
if (!/^[A-Za-z0-9_]+$/.test(DB)) throw new Error("DB_NAME may contain only letters, digits and _");

const conn = await mysql.createConnection({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  multipleStatements: true,
  timezone: "Z",
  ssl: ["1", "true"].includes((process.env.DB_SSL || "").toLowerCase()) ? { rejectUnauthorized: true } : undefined,
});
await conn.query("SET time_zone = '+00:00'");

let schema = fs.readFileSync(path.join(dbDir, "chatbot_platform_schema.sql"), "utf8");
schema = schema.replace(/SET @db_name\s*=\s*'[^']*';/, `SET @db_name = '${DB}';`);
// The trailing "list the tables" SELECT is only useful in an interactive client.
console.log(`→ Applying base schema to database "${DB}" …`);
await conn.query(schema);
await conn.query(`USE \`${DB}\``);

const files = fs
  .readdirSync(path.join(dbDir, "migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort();
for (const f of files) {
  const sql = fs.readFileSync(path.join(dbDir, "migrations", f), "utf8");
  const version = (sql.match(/--\s*version:\s*([\w.-]+)/) || [])[1];
  if (version) {
    const [rows] = await conn.query("SELECT 1 FROM schema_migrations WHERE version = ? AND is_deleted = 0", [version]);
    if (rows.length) {
      console.log(`✓ ${f} (already applied)`);
      continue;
    }
  }
  console.log(`→ Applying ${f} …`);
  await conn.query(sql);
}
const [tables] = await conn.query("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?", [DB]);
console.log(`✓ Database ready: ${tables[0].n} tables in "${DB}".`);
await conn.end();

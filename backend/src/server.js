import http from "node:http";
import { env, validateEnv } from "./config/env.js";
import { pingDb, pool } from "./db/pool.js";
import { createApp } from "./app.js";
import { attachSocket } from "./realtime/socket.js";
import { startScheduler } from "./jobs/scheduler.js";

validateEnv();

try {
  await pingDb();
} catch (e) {
  console.error(`\n[db] Cannot connect to MariaDB at ${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}: ${e.message}`);
  console.error("Check DB_* in backend/.env and run `npm run db:setup` once to create the tables.\n");
  process.exit(1);
}

const app = createApp();
const server = http.createServer(app);
attachSocket(server);
if (env.RUN_BACKGROUND_JOBS) startScheduler();

server.listen(env.PORT, () => {
  console.log(`\n✓ Parley backend listening on http://localhost:${env.PORT}`);
  console.log(`  Public URL:   ${env.PUBLIC_API_URL}`);
  console.log(`  Frontend:     ${env.FRONTEND_URL}`);
  console.log(`  AI service:   ${env.AI_SERVICE_URL}\n`);
});

function shutdown(sig) {
  console.log(`\n${sig} received, shutting down…`);
  server.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));

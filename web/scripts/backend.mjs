import { startLocalServer } from "./local-server.mjs";
import { databasePath } from "./runtime-config.mjs";
const service = await startLocalServer({
  port: Number(process.env.API_PORT || 8787),
  config: { APP_ORIGIN: process.env.APP_ORIGIN || `http://localhost:${process.env.WEB_PORT || "3000"}` },
});
console.log(`DiviWish 单机版 API: http://127.0.0.1:${service.port}（SQLite，无需登录）`);
console.log(`数据库：${databasePath()}`);
process.on("SIGINT", async () => { await service.close(); process.exit(0); });
process.on("SIGTERM", async () => { await service.close(); process.exit(0); });

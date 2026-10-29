import { startLocalServer } from "./local-server.mjs";
import { databasePath } from "./runtime-config.mjs";
const host = process.env.HOST || "127.0.0.1";
const service = await startLocalServer({ port: Number(process.env.WEB_PORT || 3000), host, assets: true });
console.log(`DiviWish 单机版: http://${host}:${service.port}/discovery`);
console.log(`数据库：${databasePath()}`);
process.on("SIGINT", async () => { await service.close(); process.exit(0); });
process.on("SIGTERM", async () => { await service.close(); process.exit(0); });

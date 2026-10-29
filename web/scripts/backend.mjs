// Node 24 runs the same TypeScript Worker handlers against isolated local SQLite.
import { startLocalServer } from "./local-server.mjs";
const service = await startLocalServer({ port: Number(process.env.API_PORT || 8787) });
console.log(`DiviWish 本地账号 API: http://localhost:${service.port}（Node.js + SQLite）`);
console.log("个人数据库和旧 D1 均保留；不会部署到 Cloudflare。");
process.on("SIGINT", async () => { await service.close(); process.exit(0); });
process.on("SIGTERM", async () => { await service.close(); process.exit(0); });

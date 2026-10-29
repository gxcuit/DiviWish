import { startLocalServer } from "./local-server.mjs";
const service = await startLocalServer({ port: Number(process.env.WEB_PORT || 3000), assets: true });
console.log(`DiviWish 本地预览: http://localhost:${service.port}/discovery`);
process.on("SIGINT", async () => { await service.close(); process.exit(0); });
process.on("SIGTERM", async () => { await service.close(); process.exit(0); });

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resend } from "resend";
import { resolveTxt } from "node:dns/promises";
import { readPrivateEnv, setPrivateValue } from "./private-env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const setupFile = path.join(root, ".local/resend-setup.env"), runtimeFile = path.join(root, ".dev.vars");
const config = readPrivateEnv(setupFile), runtime = readPrivateEnv(runtimeFile);
const directory = path.join(root, ".local");
mkdirSync(directory, { recursive: true });
const stateFile = path.join(directory, "resend-setup.json");
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
function saveState() { writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 }); }
const statusOnly = process.argv.includes("--status");
if (!config.RESEND_SETUP_API_KEY) {
  console.error("请在 web/.local/resend-setup.env 填写 RESEND_SETUP_API_KEY（临时 Full access 密钥），不要在聊天中发送密钥。");
  process.exit(1);
}
const resend = new Resend(config.RESEND_SETUP_API_KEY);
async function check(result, label) {
  const { data, error } = await result;
  if (error) throw new Error(`${label}: ${error.name} (HTTP ${error.statusCode ?? "network"})`);
  return data;
}
const domainName = config.RESEND_DOMAIN || "mail.example.com";
try {
  if (!state.domainId) {
    const domains = await check(resend.domains.list(), "读取域名");
    const existing = domains.data.find(domain => domain.name === domainName);
    if (!existing && statusOnly) throw new Error("该域名尚未配置，请先运行 npm run resend:setup");
    const domain = existing || await check(resend.domains.create({
      name: domainName, region: config.RESEND_REGION || "ap-northeast-1",
      capabilities: { sending: "enabled", receiving: "disabled" },
    }), "创建发信域名");
    state.domainId = domain.id; state.domainName = domainName; saveState();
  }
  let domain = await check(resend.domains.get(state.domainId), "读取域名状态");
  if (domain.name !== domainName) throw new Error("配置域名与本地记录不一致，请先核对 .local/resend-setup.json");
  if (!statusOnly && !runtime.RESEND_API_KEY) {
    const key = await check(resend.apiKeys.create({ name: "DiviWish local sending", permission: "sending_access", domain_id: domain.id }), "创建发送密钥");
    setPrivateValue(runtimeFile, "RESEND_API_KEY", key.token);
    state.sendingKeyId = key.id; saveState();
    console.log("已创建并私密保存域名专用发送密钥；密钥值不会输出。");
  }
  if (!statusOnly && !runtime.RESEND_OTP_TEMPLATE_ID) {
    const templates = await check(resend.templates.list(), "读取邮件模板");
    let template = templates.data.find(item => item.alias === "diviwish-login-otp");
    if (!template) {
      const draft = path.join(directory, "resend-otp-template.html");
      if (!existsSync(draft)) throw new Error("请先准备 .local/resend-otp-template.html 邮件模板草稿");
      template = await check(resend.templates.create({ name: "DiviWish 登录验证码", alias: "diviwish-login-otp",
        from: runtime.RESEND_FROM, subject: "你的息望登录验证码：{{{CODE}}}", html: readFileSync(draft, "utf8"),
        variables: [{ key: "CODE", type: "string" }, { key: "EXPIRES_MINUTES", type: "string" }],
      }), "创建验证码模板");
      state.templateId = template.id; saveState();
      await check(resend.templates.publish(template.id), "发布 Resend 邮件模板");
    }
    const actual = await check(resend.templates.get(template.id), "核对模板变量");
    const variables = actual.variables.map(variable => variable.key).sort();
    if (JSON.stringify(variables) !== JSON.stringify(["CODE", "EXPIRES_MINUTES"])) throw new Error("邮件模板变量不匹配，请核对 CODE 和 EXPIRES_MINUTES");
    setPrivateValue(runtimeFile, "RESEND_OTP_TEMPLATE_ID", template.id);
    state.templateId = template.id; saveState();
    console.log(`已配置 Resend 验证码模板 ${template.id}，变量 CODE / EXPIRES_MINUTES。`);
  }
  if (!statusOnly) {
    await check(resend.domains.verify(domain.id), "启动域名验证");
    domain = await check(resend.domains.get(domain.id), "读取 DNS 记录");
  }
  const dns = domain.records.filter(record => record.record === "DKIM" || record.record === "SPF").map(record => ({
    type: record.type, name: record.name, value: record.value, ...(record.priority === undefined ? {} : { priority: record.priority }),
    ttl: record.ttl, proxy: false, status: record.status,
  }));
  let dmarcExists = false;
  try { dmarcExists = (await resolveTxt(`_dmarc.${domainName}`)).some(parts => parts.join("").startsWith("v=DMARC1")); } catch { /* Missing DNS is expected during setup. */ }
  if (!dmarcExists) dns.push({ type: "TXT", name: `_dmarc.${domainName}`, value: "v=DMARC1; p=none;", ttl: "Auto", proxy: false, status: "not_added" });
  state.domainStatus = domain.status; state.dns = dns; saveState();
  const lines = ["# Resend 发信域名 DNS 待配置记录", "", `域名：${domainName}`, `状态：${domain.status}`, "", "这些记录尚未自动写入 Cloudflare。请审核后在 DNS 中添加，代理关闭。", "", "| 类型 | 名称 | 内容 | 优先级 |", "| --- | --- | --- | --- |",
    ...dns.map(record => `| ${record.type} | ${record.name} | ${record.value} | ${record.priority ?? "—"} |`), "", `自动配置入口：https://resend.com/domains/${domain.id}`, ""];
  writeFileSync(path.join(directory, "resend-dns-records.md"), lines.join("\n"));
  console.log(JSON.stringify({ domain: domain.name, status: domain.status, region: domain.region, domainId: domain.id, templateId: state.templateId,
    dnsRecords: dns, autoConfigureUrl: `https://resend.com/domains/${domain.id}` }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Resend 配置失败");
  process.exitCode = 1;
}

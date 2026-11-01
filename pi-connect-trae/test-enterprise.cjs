/**
 * Offline regression test for the enterprise (企业版) Trae CN support.
 *
 * Covers, without a network or a signed-in account:
 *   1. gateway detection + cache semantics against a fake Trae CN install
 *      (fresh scan, cache hit, rotated logs, personal account, no IDE);
 *   2. `PI_TRAE_CN_CHAT_BASE` winning over detection, normalised;
 *   3. every SOLO body carrying `request_id`/`session_id` (the tenant gateway
 *      answers `4001 "param is invalid"` without them);
 *   4. an upstream error leaving the bridge as an OpenAI-style error frame
 *      instead of erroring the stream (which used to kill the Pi process);
 *   5. a healthy stream still terminating with its finish reason + `[DONE]`.
 *
 * Run with: node pi-connect-trae/test-enterprise.cjs
 */
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const CORE = pathToFileURL(join(__dirname, "lib", "trae-core.js")).href;
const TENANT = "https://console.enterprise.trae.cn";

const SANDBOX = mkdtempSync(join(tmpdir(), "trae-enterprise-"));
const HOME = join(SANDBOX, "home");
const APPDATA = join(SANDBOX, "appdata");
const LOGS = join(APPDATA, "Trae CN", "logs");

/** A synthetic IDE log carrying one login response. */
const hostInfo = (host) =>
  `[info] login response {"HostInfo":{"Console":"${host}","Api":"${host}","Core":"${host}"},"x":1}\n`;

/** Write one IDE log session (`YYYYMMDDThhmmss`). */
const session = (stamp, body) => {
  mkdirSync(join(LOGS, stamp), { recursive: true });
  writeFileSync(join(LOGS, stamp, "main.log"), body);
};

/** Recreate an empty fake machine: no logs, no cache. */
const reset = () => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(APPDATA, { recursive: true, force: true });
  mkdirSync(join(HOME, ".pi", "agent", "cache", "dsh-connect-trae"), { recursive: true });
  mkdirSync(join(APPDATA, "Trae CN", "User", "globalStorage"), { recursive: true });
  writeFileSync(join(APPDATA, "Trae CN", "User", "globalStorage", "storage.json"), "{}");
};

/**
 * Import the core in a child process with a redirected home/appdata, and report
 * what the detection produced. A child keeps each scenario's import-time work
 * (and its cache file) isolated.
 */
const probe = (env = {}) => {
  const run = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const core = await import(${JSON.stringify(CORE)});
       console.log(JSON.stringify({
         base: core.TRAE_CN_ENTERPRISE_BASE,
         chat: core.REGION_GATEWAYS.cn.chat,
         remote: core.REGION_GATEWAYS.cn.remote,
         pay: core.REGION_GATEWAYS.cn.pay,
         globalChat: core.REGION_GATEWAYS.ai.chat,
       }));`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, USERPROFILE: HOME, HOME, APPDATA, PI_TRAE_CN_CHAT_BASE: "", ...env },
    },
  );
  assert.equal(run.status, 0, run.stderr || run.stdout);
  return JSON.parse(run.stdout.trim());
};

let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok ${name}`);
};

(async () => {
  // --- 1. detection and cache semantics (fake install) ---
  await check("fresh scan finds the tenant host in the newest IDE log", () => {
    reset();
    session("20260101T000001", hostInfo(TENANT));
    const out = probe();
    assert.equal(out.base, TENANT);
    assert.equal(out.chat, TENANT);
    assert.equal(out.remote, `${TENANT}/api/remote/v1`);
    assert.equal(out.pay, "https://api.trae.cn", "credit/check-in base stays public");
    assert.equal(out.globalChat, "https://coresg-normal.trae.ai", "global region untouched");
  });

  await check("same IDE session reuses the remembered host (cache hit)", () => {
    assert.equal(probe().base, TENANT);
  });

  await check("rotated/cleaned logs keep the remembered host", () => {
    rmSync(LOGS, { recursive: true, force: true });
    assert.equal(probe().base, TENANT);
  });

  await check("a log without a tenant host never drops a known tenant host", () => {
    reset();
    session("20260101T000001", hostInfo(TENANT));
    assert.equal(probe().base, TENANT);
    session("20260102T000001", '[info] login response {"HostInfo":{"Api":"https://api.trae.cn"}}\n');
    assert.equal(probe().base, TENANT);
  });

  await check("an ignored sibling directory (logs/aha_log) is not a session", () => {
    reset();
    session("20260101T000001", hostInfo(TENANT));
    mkdirSync(join(LOGS, "aha_log"), { recursive: true });
    writeFileSync(join(LOGS, "aha_log", "aha.log"), "zzz\n");
    const out = probe();
    assert.equal(out.base, TENANT);
    const cache = JSON.parse(
      readFileSync(join(HOME, ".pi", "agent", "cache", "dsh-connect-trae", "gateway-cn.json"), "utf8"),
    );
    assert.match(cache.generation, /20260101T000001[\\/]main\.log$/);
  });

  await check("personal machine: no tenant host -> public gateway", () => {
    reset();
    session("20260101T000001", "[info] nothing interesting here\n");
    const out = probe();
    assert.equal(out.base, undefined);
    assert.equal(out.chat, "https://trae-api-cn.mchost.guru");
  });

  await check("no IDE installed -> public gateway", () => {
    reset();
    const out = probe();
    assert.equal(out.base, undefined);
    assert.equal(out.chat, "https://trae-api-cn.mchost.guru");
  });

  // --- 2. explicit override beats detection ---
  await check("PI_TRAE_CN_CHAT_BASE overrides both cn bases and is normalised", () => {
    reset();
    session("20260101T000001", hostInfo(TENANT));
    const out = probe({ PI_TRAE_CN_CHAT_BASE: "https://tenant.example.test///" });
    assert.equal(out.base, "https://tenant.example.test");
    assert.equal(out.chat, "https://tenant.example.test");
    assert.equal(out.remote, "https://tenant.example.test/api/remote/v1");
    assert.equal(out.pay, "https://api.trae.cn");
  });

  // --- 3. request_id / session_id are always present ---
  const core = await import(CORE);
  await check("prepareSoloBody fills request_id/session_id and keeps caller values", () => {
    const generated = JSON.parse(
      core.prepareSoloBody(JSON.stringify({ model: "glm-5.2", messages: [{ role: "user", content: "hi" }] })),
    );
    assert.match(generated.request_id, /^[0-9a-f-]{36}$/);
    assert.match(generated.session_id, /^[0-9a-f-]{36}$/);
    assert.notEqual(generated.request_id, generated.session_id);
    const kept = JSON.parse(
      core.prepareSoloBody(JSON.stringify({ model: "glm-5.2", messages: [], request_id: "r1", session_id: "s1" })),
    );
    assert.equal(kept.request_id, "r1");
    assert.equal(kept.session_id, "s1");
  });

  // --- 4/5. bridge stream: upstream errors and healthy streams ---
  const encoder = new TextEncoder();
  const sse = (chunk) =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );

  await check("upstream error becomes an error frame + [DONE]", async () => {
    const text = await core
      .bridgeTraeSoloStream(
        sse('event:error\ndata: {"code":4008,"message":"Your requests have exceeded the quota."}\n\n'),
        "glm-5.2",
      )
      .text();
    assert.match(text, /"type":"trae_upstream_error"/);
    assert.match(text, /exceeded the quota/);
    assert.match(text, /data: \[DONE\]/);
  });

  await check("healthy stream still ends with its finish reason + [DONE]", async () => {
    const text = await core
      .bridgeTraeSoloStream(sse('event:done\ndata: {"finish_reason":"stop"}\n\n'), "glm-5.2")
      .text();
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /data: \[DONE\]/);
    assert.doesNotMatch(text, /trae_upstream_error/);
  });

  rmSync(SANDBOX, { recursive: true, force: true });
  console.log(`\n${passed} assertions passed`);
})().catch((error) => {
  rmSync(SANDBOX, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
});

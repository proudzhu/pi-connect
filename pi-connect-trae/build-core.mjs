// Builds pi-extensions/dsh-connect-trae/lib/trae-core.js from the DSH trae bundle.
// 1. Replace imports
// 2. Drop the DSH adapter region (createTraeAdapter uses PiAiAdapter)
// 3. Patch auth paths to a Pi-owned dir
// 4. Patch refreshNow's atomic write to plain fs
// 4e. Drop the per-request debug dump
// 4f. Report a partially discovered SOLO directory instead of throwing
// 4g. Enterprise (企业版) Trae CN gateway, request ids, upstream error frames
// 5. Keep only protocol core (1-3111); strip usage/web-status/DSH entry
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, "..", "..", "profiles", "desktop", "node_modules", "dsh-connect-trae", "lib", "index.js");
const DST = join(__dirname, "lib", "trae-core.js");

const lines = readFileSync(SRC, "utf8").split("\n");
console.log(`source lines: ${lines.length}`);

// --- 1. Replace the import block (lines 1-16, 1-based) ---
const NEW_IMPORTS = `/**
 * Trae protocol core for the Pi port of dsh-connect-trae.
 *
 * This module is a surgically extracted copy of the DSH plugin bundle:
 *  - the DSH adapter region (PiAiAdapter / resolveRetryPolicy) is removed;
 *  - the DSH-only usage / web-status / index entry regions are removed;
 *  - the plugin-owned auth-file paths are moved under ~/.pi/agent;
 *  - the atomic-write helpers are replaced with plain fs writes.
 *
 * Everything else (credential store, refresh, identity, shim, protocol,
 * solo upstream, remote catalog, bridge, SSE codec) is unchanged.
 */
import { readFile, rm, stat, mkdir, writeFile } from "node:fs/promises";
import { createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir, cpus, hostname, release } from "node:os";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
`;

// Find the line where "#region src/catalog.ts" starts (currently line 17)
const catalogRegionIdx = lines.findIndex((l) => l.trim() === "//#region src/catalog.ts");
if (catalogRegionIdx < 0) throw new Error("catalog region not found");
const newLines = [...NEW_IMPORTS.split("\n"), ...lines.slice(catalogRegionIdx)];
console.log(`after import replacement: ${newLines.length} lines`);

// --- 2. Remove the adapter region (between src/catalog.ts end and src/decrypt.ts) ---
const decryptIdx = newLines.findIndex((l) => l.trim() === "//#region src/decrypt.ts");
if (decryptIdx < 0) throw new Error("decrypt region not found");
// catalog region spans from catalogRegionIdx to the line before decryptIdx;
// the adapter region sits between them. Find its start.
const adapterStart = newLines.findIndex((l, i) => i > catalogRegionIdx && l.includes("src/adapter.ts"));
if (adapterStart < 0) throw new Error("adapter region marker not found");
const adapterBody = newLines.slice(adapterStart, decryptIdx);
// Verify the adapter body contains the DSH-only pieces
if (!adapterBody.some((l) => l.includes("PiAiAdapter"))) throw new Error("adapter region missing PiAiAdapter");
newLines.splice(adapterStart, decryptIdx - adapterStart);
console.log(`after adapter removal: ${newLines.length} lines`);

// --- 3. Patch traeOwnAuthPath / legacyTraeOwnAuthPath ---
// Replace the function bodies to use a Pi-owned dir under ~/.pi/agent.
const PI_AUTH_DIR = `join(homedir(), ".pi", "agent", "cache", "dsh-connect-trae")`;
let text = newLines.join("\n");
text = text.replace(
  /function traeOwnAuthPath\(region\) \{\n\treturn join\(resolveDshHome\(\), `\$\{TRAE_OWN_PREFIX\}\.\$\{region\}\.json`\);\n\}/,
  `function traeOwnAuthPath(region) {
\treturn join(${PI_AUTH_DIR}, \`\${TRAE_OWN_PREFIX}.\${region}.json\`);
}`,
);
text = text.replace(
  /function legacyTraeOwnAuthPath\(\) \{\n\treturn join\(resolveDshHome\(\), TRAE_AUTH_FILENAME\);\n\}/,
  `function legacyTraeOwnAuthPath() {
\treturn join(${PI_AUTH_DIR}, TRAE_AUTH_FILENAME);
}`,
);
if (text.includes("resolveDshHome")) throw new Error("resolveDshHome still referenced");

// --- 4. Patch refreshNow's atomic write ---
// The template literal contains a literal `\n` escape and ${...} markers, so a
// verbatim match is fragile. Match line-by-line on stable tokens instead.
const ATOMIC_ANCHOR = "const ownPath = this.ownAuthPath();";
const linesArr = text.split("\n");
const anchorIdx = linesArr.findIndex((l) => l.includes(ATOMIC_ANCHOR));
if (anchorIdx < 0) throw new Error("refreshNow ownPath anchor not found");
// The block runs from the anchor to the first following "});" that closes withFileLock
// (a tab-indented "});" line). Replace [anchor, thatClose] with the plain-fs write.
let closeIdx = -1;
for (let i = anchorIdx + 1; i < linesArr.length; i++) {
  if (/^\t\t\t\}\);$/.test(linesArr[i])) {
    closeIdx = i;
    break;
  }
}
if (closeIdx < 0) throw new Error("withFileLock close not found");
const replaced = [
  `\t\t\tconst ownPath = this.ownAuthPath();`,
  `\t\t\tawait mkdir(dirname(ownPath), { recursive: true });`,
  `\t\t\tawait writeFile(ownPath, \`\${JSON.stringify({`,
  `\t\t\t\tversion: OWN_VERSION,`,
  `\t\t\t\tcredential: refreshed`,
  `\t\t\t}, null, 2)}\\n\`, { mode: 384 });`,
];
linesArr.splice(anchorIdx, closeIdx - anchorIdx + 1, ...replaced);
text = linesArr.join("\n");
if (text.includes("withFileLock") || text.includes("writeFileAtomic")) throw new Error("atomic write still referenced");

// --- 4b. Unref the shim's listener ---
// Pi's extension docs forbid starting sockets in the factory; the shim is
// started lazily / from `session_start` instead. `unref()` is the second half
// of that contract: it guarantees the in-process shim can never be what keeps
// a session-less invocation alive.
const LISTEN_RE = /(\n\tserver\.listen\(0, "127\.0\.0\.1"\);)/;
if (!LISTEN_RE.test(text)) throw new Error("trae shim listen call not found");
text = text.replace(
  LISTEN_RE,
  `$1\n\t// Pi port: never let the shim's listener hold the process open.\n\tserver.unref();`,
);

// --- 4c. Complete the reasoning-effort vocabulary ---
// Trae's own `reasoning_effort_options` may name `minimal` / `medium` (this
// file's TRAE_REASONING_EFFORTS lists both). The DSH parser only knew
// light/high/extra_high, and the inverse mapping collapsed every other name
// onto "high" — so a level Trae offered could be advertised to the user as a
// different level. Patch both tables.
const EFFORT_MAP_SRC = 'const EFFORT_MAP = {\n\tlight: "low",\n\thigh: "high",\n\textra_high: "xhigh"\n};';
const EFFORT_MAP_DST = `const EFFORT_MAP = {
	minimal: "minimal",
	light: "low",
	medium: "medium",
	high: "high",
	extra_high: "xhigh"
};
/**
* The inverse of EFFORT_MAP: pi level -> Trae wire spelling.
*
* Kept as an explicit table instead of re-deriving it, because the inline
* ternary this replaces collapsed every name it did not know onto "high":
* "minimal" and "medium" - both of which Trae's own reasoning_effort_options
* may advertise (see TRAE_REASONING_EFFORTS) - were shown to the user as high
* and then sent to Trae as high. Dropping an offered level is bad; relabelling
* it as a different level is worse.
*/
const TRAE_REASONING_WIRE = {
	minimal: "minimal",
	low: "light",
	medium: "medium",
	high: "high",
	xhigh: "extra_high"
};`;
if (!text.includes(EFFORT_MAP_SRC)) throw new Error("EFFORT_MAP block not found");
text = text.replace(EFFORT_MAP_SRC, EFFORT_MAP_DST);
const EFFORT_REVERSE_SRC = 'Object.fromEntries(model.reasoning.supported.map((effort) => [effort, effort === "low" ? "light" : effort === "xhigh" ? "extra_high" : "high"]))';
const EFFORT_REVERSE_DST = 'Object.fromEntries(model.reasoning.supported.map((effort) => [effort, TRAE_REASONING_WIRE[effort] ?? effort]))';
if (!text.includes(EFFORT_REVERSE_SRC)) throw new Error("reasoning-effort inverse mapping not found");
text = text.split(EFFORT_REVERSE_SRC).join(EFFORT_REVERSE_DST);

// --- 4d. Restore the published CN fallback windows and efforts ---
// The bootstrap roster is what Pi serves before the first live directory
// refresh lands (session-less calls, failed refresh, signed out). The DSH
// bundle carried only `contextWindow: 2e5`, so every fallback row advertised the
// dev window and — because it carried no `reasoningEfforts` at all — was
// reported as a non-reasoning model, i.e. thinking permanently off. Both facts
// are reproduced from Trae's own published metadata (see docs/CATALOG_EVIDENCE
// in the DSH bundle): no value here is invented, and `kimi-k2.6` keeps no
// efforts because Trae publishes none for it.
const FB_START = "const FALLBACK_TRAE_MODELS = [";
const fbStart = text.indexOf(FB_START);
if (fbStart < 0) throw new Error("FALLBACK_TRAE_MODELS not found");
const fbEnd = text.indexOf("\n];", fbStart);
if (fbEnd < 0) throw new Error("FALLBACK_TRAE_MODELS end not found");
const FB_DST = `const FALLBACK_TRAE_MODELS = [
	{
		id: "DeepSeek-V4-Flash-Official",
		name: "DeepSeek-V4-Flash",
		contextWindow: 2e5,
		maxContextWindow: 1e6,
		reasoningSupported: true,
		reasoning: { supported: ["low", "high", "xhigh"], defaultEffort: "high" },
		reasoningEfforts: { low: "light", high: "high", xhigh: "extra_high" }
	},
	{
		id: "DeepSeek-V4-Pro-Official",
		name: "DeepSeek-V4-Pro",
		contextWindow: 2e5,
		maxContextWindow: 1e6,
		reasoningSupported: true,
		reasoning: { supported: ["low", "high", "xhigh"], defaultEffort: "high" },
		reasoningEfforts: { low: "light", high: "high", xhigh: "extra_high" }
	},
	{
		id: "glm-5.2",
		name: "GLM-5.2",
		contextWindow: 2e5,
		maxContextWindow: 1e6,
		reasoningSupported: true,
		reasoning: { supported: ["high", "xhigh"], defaultEffort: "high" },
		reasoningEfforts: { high: "high", xhigh: "extra_high" }
	},
	{
		id: "kimi-k2.6",
		name: "Kimi-K2.6",
		contextWindow: 2e5
	}
];`;
text = text.slice(0, fbStart) + FB_DST + text.slice(fbEnd + 3);

// --- 4e. Drop the per-request debug dump ---
// The DSH bundle logs every chat request through `logger.warn`:
//
//   options.logger?.warn("dsh-connect-trae: chat request received", { model, ... })
//
// In DSH that lands in a log pane. In Pi the same call goes to `console.warn`,
// and the TUI owns the terminal: the object printed straight into the message
// area on every single turn (reported as issue #1 with a screenshot). It is a
// debugging leftover with no diagnostic value in steady state, so the whole
// statement is removed rather than demoted — `PI_CONNECT_DEBUG` in index.js
// already covers "I want to see what the plugin is doing".
const DEBUG_LOG_ANCHOR = 'options.logger?.warn("dsh-connect-trae: chat request received", {';
const debugLines = text.split("\n");
const debugStart = debugLines.findIndex((l) => l.includes(DEBUG_LOG_ANCHOR));
if (debugStart < 0) throw new Error("chat-request debug log not found");
let debugEnd = -1;
for (let i = debugStart + 1; i < debugLines.length; i++) {
  if (/^\t{4}\}\);$/.test(debugLines[i])) {
    debugEnd = i;
    break;
  }
}
if (debugEnd < 0) throw new Error("chat-request debug log close not found");
debugLines.splice(debugStart, debugEnd - debugStart + 1);
text = debugLines.join("\n");
if (text.includes("chat request received")) throw new Error("chat-request debug log still present");

// --- 4f. Report a partially discovered directory instead of throwing ---
// The SOLO roster is split across directory functions. A per-function failure
// must not take the whole region down — an account with no access to one mode
// fails deterministically, and dropping the models the other function listed
// leaves the region with nothing. So keep the partial union, hand it back as
// `{ models, failures }` from `fetchModelsDetailed`, and let the caller retry
// rather than cache the gap. `fetchModels` stays a plain array for callers that
// do not care. Same rule as the Cyrene copy.
const SOLO_MODELS_ANCHOR = "const models = [...byId.values()];";
const soloLines = text.split("\n");
const soloIdx = soloLines.findIndex((l) => l.includes(SOLO_MODELS_ANCHOR));
if (soloIdx < 0) throw new Error("SOLO models union anchor not found");
const SOLO_RETURN = "\t\treturn { models, failures };";
soloLines[soloIdx + 1] = SOLO_RETURN;
text = soloLines.join("\n");

const FETCH_ANCHOR =
  "\tasync fetchModels(signal) {\n\t\tconst [credential, identity] = await Promise.all([this.options.credential(), this.options.identity()]);";
const FETCH_REPLACEMENT = [
  "\tasync fetchModels(signal) {",
  "\t\treturn (await this.fetchModelsDetailed(signal)).models;",
  "\t}",
  "\t/**",
  "\t* Read the callable roster, keeping the per-function failures.",
  "\t*",
  "\t* Returns `{ models, failures }`. A partial union is still returned: the",
  "\t* models the answering functions listed are callable, and refusing them",
  "\t* would take the whole region down for an account that has no access to",
  "\t* one of the modes, which is a deterministic condition rather than a",
  "\t* transient one.",
  "\t*/",
  "\tasync fetchModelsDetailed(signal) {",
  "\t\tconst [credential, identity] = await Promise.all([this.options.credential(), this.options.identity()]);",
].join("\n");
if (text.split(FETCH_ANCHOR).length !== 2) throw new Error("SOLO fetchModels anchor not unique");
text = text.replace(FETCH_ANCHOR, FETCH_REPLACEMENT);

// --- 4g. Enterprise (企业版) Trae CN gateway, request ids, error frames ---
// An enterprise (tenant) Trae CN seat does not bill through the public gateway.
// The tenant install's login response carries `HostInfo` with the tenant hosts,
// while `trae-api-cn.mchost.guru` only ever sees the personal credit packs —
// empty for an enterprise seat, so it answers every request with
// `event:error {"code":4008,"message":"Your requests have exceeded the quota."}`.
// The tenant host is therefore resolved at import time (env override → newest
// IDE `main.log` → remembered host → public gateway, which keeps personal
// accounts exactly as they were) and written over `REGION_GATEWAYS.cn`.
//
// The same gateway rejects a SOLO body without `request_id`/`session_id`
// (`4001 "param is invalid"`; the public gateway does not care), and an
// upstream error must leave the bridge stream as an OpenAI-style error frame
// rather than `controller.error()` — in Bun that surfaces as an unhandled
// rejection and takes the whole Pi process down instead of reporting a model
// error.
const ENT_REGION_ANCHOR = '\t\tpay: "https://growsg-normal.trae.ai"\n\t}\n};';
if (text.split(ENT_REGION_ANCHOR).length !== 2) throw new Error("REGION_GATEWAYS ai block not found");
const ENT_GATEWAY_BLOCK = `/**
* Enterprise (企业版) Trae CN tenants do not bill through the public gateway.
*
* The tenant install's login response carries \`HostInfo\` with the tenant hosts —
* observed on a real enterprise tenant (productType 230) as \`Api\`/\`Core\`/\`Console\` =
* https://console.enterprise.trae.cn and \`SoloDomain\` =
* https://work.enterprise.trae.cn. That gateway is what serves the enterprise
* roster and bills the enterprise quota. The public \`trae-api-cn.mchost.guru\`
* only ever sees the personal credit packs, which are empty for an enterprise
* seat, so it answers with
* \`event:error {"code":4008,"message":"Your requests have exceeded the quota."}\`
* however much quota the enterprise console shows.
*
* Resolved at import time from, in order: the \`PI_TRAE_CN_CHAT_BASE\` env var, the
* newest Trae CN IDE \`main.log\` \`"HostInfo"\` block, the remembered host (so a
* rotated or cleaned log cannot silently put an enterprise seat back on the
* public gateway), and finally the public gateway — personal accounts are
* untouched.
*/
const TRAE_CN_ENTERPRISE_HOST_RE = /enterprise\\.trae\\.(?:cn|com)/i;
/** Probe order: the hosts the IDE itself sends API traffic to come first. */
const TRAE_CN_ENTERPRISE_HOST_KEYS = ["Api", "Core", "Console", "SoloDomain"];
/** Newest log sessions to read; older ones may predate the account switch. */
const TRAE_CN_LOG_SESSION_LIMIT = 4;
/** Session directory name: \`YYYYMMDDThhmmss\`, written once per IDE start. */
const TRAE_CN_LOG_SESSION_RE = /^\\d{8}T\\d{6}$/;
/** Remembers the detected tenant host across starts. */
function traeCnGatewayCachePath() {
\treturn join(homedir(), ".pi", "agent", "cache", "dsh-connect-trae", "gateway-cn.json");
}
/**
* Trae CN install roots to look for logs under, derived from the storage
* candidates so that the enterprise probe and the credential scanner agree on
* which installation they describe (same edition, same directory spellings,
* same platform rules).
*/
function traeCnInstallRoots() {
\tconst roots = [];
\tfor (const candidate of traeStorageCandidates()) {
\t\tif (candidate.source !== "desktop" || candidate.edition !== "cn") continue;
\t\tconst root = dirname(dirname(dirname(candidate.path)));
\t\tif (!roots.includes(root)) roots.push(root);
\t}
\treturn roots;
}
/**
* Newest Trae CN log sessions, newest first.
*
* The IDE writes one directory per session (\`logs/<ISO-ish start stamp>/\`), so
* the newest name is also the "generation" of the log: a login — and therefore
* any tenant switch — writes a fresh \`HostInfo\` into the session that is
* starting, which is a new directory.
*/
function traeCnLogSessions() {
\tconst sessions = [];
\tfor (const root of traeCnInstallRoots()) {
\t\tlet names;
\t\ttry {
\t\t\tnames = readdirSync(join(root, "logs")).sort().reverse();
\t\t} catch {
\t\t\tcontinue;
\t\t}
\t\t// \`logs/\` also holds non-session entries (the IDE's \`aha_log\` telemetry
\t\t// directory, ad-hoc dumps). Prefer the session stamps; if an installer ever
\t\t// renames them, fall back to plain name order rather than reporting no
\t\t// sessions at all.
\t\tconst stamped = names.filter((name) => TRAE_CN_LOG_SESSION_RE.test(name));
\t\tfor (const name of (stamped.length > 0 ? stamped : names).slice(0, TRAE_CN_LOG_SESSION_LIMIT)) sessions.push({
\t\t\troot,
\t\t\tname,
\t\t\tmainLog: join(root, "logs", name, "main.log")
\t\t});
\t}
\treturn sessions;
}
/** Enterprise host named by the last \`"HostInfo"\` block of one log, if any. */
function traeCnHostInfoHost(text) {
\tconst at = text.lastIndexOf('"HostInfo"');
\tif (at === -1) return void 0;
\t// \`HostInfo\` is one dense JSON blob; 4 KiB past its key always covers the
\t// host fields above the AB/APM telemetry sub-objects.
\tconst chunk = text.slice(at, at + 4e3);
\tfor (const key of TRAE_CN_ENTERPRISE_HOST_KEYS) {
\t\tconst host = new RegExp(\`"\${key}":"(https?:\\\\/\\\\/[^"]+)"\`).exec(chunk)?.[1];
\t\tif (typeof host === "string" && TRAE_CN_ENTERPRISE_HOST_RE.test(host)) return host.replace(/\\/+$/, "");
\t}
}
function readTraeCnGatewayCache(cachePath) {
\ttry {
\t\tconst cached = JSON.parse(readFileSync(cachePath, "utf8"));
\t\tif (cached?.version !== 1) return void 0;
\t\treturn {
\t\t\tgeneration: typeof cached.generation === "string" ? cached.generation : void 0,
\t\t\tbase: typeof cached.base === "string" && cached.base !== "" ? cached.base : void 0
\t\t};
\t} catch {
\t\treturn void 0;
\t}
}
function detectTraeCnEnterpriseBase() {
\tconst override = (process.env["PI_TRAE_CN_CHAT_BASE"] ?? "").trim();
\tif (override !== "") return override.replace(/\\/+$/, "");
\tconst cachePath = traeCnGatewayCachePath();
\tconst cached = readTraeCnGatewayCache(cachePath);
\tconst sessions = traeCnLogSessions();
\tconst generation = sessions[0]?.mainLog;
\t// One scan per IDE session. The log of a running session cannot gain a second
\t// tenant, and the next IDE start writes a new session directory — which is
\t// also the moment a freshly signed-in account's \`HostInfo\` lands. So a cache
\t// hit can never hide an account switch, and a personal-account start does not
\t// re-read its (possibly huge) session logs on every Pi launch.
\tif (generation !== void 0 && cached?.generation === generation) return cached.base;
\tif (generation === void 0) return cached?.base;
\tlet base;
\tfor (const session of sessions) {
\t\tlet text;
\t\ttry {
\t\t\ttext = readFileSync(session.mainLog, "utf8");
\t\t} catch {
\t\t\tcontinue;
\t\t}
\t\tbase = traeCnHostInfoHost(text);
\t\tif (base !== void 0) break;
\t}
\t// A rotated log must not drop a known tenant host — the public gateway answers
\t// 4008 for that seat. A scan that does find a host always wins, so switching
\t// tenants is picked up from the new session's log.
\tconst remembered = base ?? cached?.base;
\ttry {
\t\tmkdirSync(dirname(cachePath), { recursive: true });
\t\twriteFileSync(cachePath, JSON.stringify({
\t\t\tversion: 1,
\t\t\tgeneration,
\t\t\tbase: remembered ?? null,
\t\t\tsavedAt: Date.now()
\t\t}, null, 2), "utf8");
\t} catch {
\t\t// A failed cache write only costs a log scan next start.
\t}
\treturn remembered;
}
const TRAE_CN_ENTERPRISE_BASE = detectTraeCnEnterpriseBase();
if (TRAE_CN_ENTERPRISE_BASE !== void 0) {
\tREGION_GATEWAYS.cn.chat = TRAE_CN_ENTERPRISE_BASE;
\tREGION_GATEWAYS.cn.remote = \`\${TRAE_CN_ENTERPRISE_BASE}/api/remote/v1\`;
}`;
text = text.replace(ENT_REGION_ANCHOR, `${ENT_REGION_ANCHOR}\n${ENT_GATEWAY_BLOCK}`);

const SOLO_BODY_ANCHOR = '\t\tstream: true,\n\t\t...Array.isArray(input["tools"])';
if (text.split(SOLO_BODY_ANCHOR).length !== 2) throw new Error("prepareSoloBody stream anchor not found");
text = text.replace(
  SOLO_BODY_ANCHOR,
  [
    "\t\tstream: true,",
    "\t\t// The enterprise (tenant) gateway rejects a body without these with",
    '\t\t// `4001 "param is invalid"`; the public gateway tolerates their absence.',
    "\t\t// The IDE always sends both (see buildTraeAgentTaskBody above).",
    '\t\trequest_id: typeof input["request_id"] === "string" && input["request_id"] !== "" ? input["request_id"] : randomUUID(),',
    '\t\tsession_id: typeof input["session_id"] === "string" && input["session_id"] !== "" ? input["session_id"] : randomUUID(),',
    '\t\t...Array.isArray(input["tools"])',
  ].join("\n"),
);

const STREAM_STATE_ANCHOR = "\tlet upstreamEnded = false;\n\tlet upstreamError;\n\tlet usage;";
if (text.split(STREAM_STATE_ANCHOR).length !== 2) throw new Error("bridge stream state anchor not found");
text = text.replace(
  STREAM_STATE_ANCHOR,
  [
    STREAM_STATE_ANCHOR,
    "\t/**",
    "\t* Turn an upstream failure into an OpenAI-style error frame.",
    "\t*",
    "\t* An upstream error (quota exhausted, decoding failure, transport reset) must",
    "\t* never be pushed into the response stream with `controller.error()`: if that",
    "\t* happens before the consumer attaches, Bun treats the stream rejection as an",
    "\t* unhandled promise rejection and takes the whole Pi process down. The frame",
    "\t* below is surfaced by Pi as an ordinary model error instead, so the session",
    "\t* survives and the user sees the upstream message.",
    "\t*/",
    "\tconst errorFrame = (error) => encoder.encode(`data: ${JSON.stringify({ error: {",
    "\t\tmessage: error.message,",
    '\t\ttype: "trae_upstream_error"',
    "\t} })}\\n\\ndata: [DONE]\\n\\n`);",
  ].join("\n"),
);

const UPSTREAM_STREAM_ERROR_RE = /^(\t+)controller\.error\(upstreamError\);$/gm;
if (text.match(UPSTREAM_STREAM_ERROR_RE)?.length !== 2) throw new Error("controller.error(upstreamError) sites not found");
text = text.replace(
  UPSTREAM_STREAM_ERROR_RE,
  "$1controller.enqueue(errorFrame(upstreamError));\n$1controller.close();",
);
const CATCH_ERROR_RE = /^(\t+)controller\.error\(error\);$/gm;
if (text.match(CATCH_ERROR_RE)?.length !== 1) throw new Error("catch controller.error site not found");
text = text.replace(
  CATCH_ERROR_RE,
  [
    "$1try {",
    "$1\tcontroller.enqueue(errorFrame(error instanceof Error ? error : new Error(String(error))));",
    "$1\tcontroller.close();",
    "$1} catch {",
    "$1\t// Stream already closed by the consumer; nothing left to report.",
    "$1}",
  ].join("\n"),
);
if (text.includes("controller.error(upstreamError)") || /controller\.error\(error\);/.test(text)) throw new Error("controller.error still present");

// --- 5. Strip the DSH-only regions, keep the protocol core + usage/check-in logic ---
// Kept: everything through `src/web-status.ts` (usage client, check-in status,
// credit/check-in projection helpers used by the Pi commands).
// Stripped from here: model-config / model-detail / redact / raw-envelope /
// upstream / index (DSH card + entry plumbing).
const cutIdx = text.split("\n").findIndex((l) => l.includes("src/model-config.ts"));
if (cutIdx < 0) throw new Error("model-config region marker not found");
const coreLines = text.split("\n").slice(0, cutIdx);
// Trim any trailing blank lines from the core
while (coreLines.length > 0 && coreLines[coreLines.length - 1].trim() === "") coreLines.pop();

const out = [
  ...coreLines,
  "",
  "//#region pi-entry",
  "/** Pi port entry point: re-export the protocol core used by the extension. */",
  "/** Provider route this bundle owns for the domestic (CN) gateway. */",
  "const TRAE_PROVIDER = \"trae\";",
  "/**",
  " * Provider route this bundle owns for the international (trae.ai) gateway.",
  " * Named `-global` to match the plugin family's convention (`workbuddy-global`);",
  " * the internal region bucket stays `ai`, which is the gateway/protocol name.",
  " */",
  "const TRAE_AI_PROVIDER = \"trae-global\";",
  "/** The provider id each region registers as. */",
  "const TRAE_PROVIDERS = {",
  "\tcn: TRAE_PROVIDER,",
  "\tai: TRAE_AI_PROVIDER",
  "};",
  "/** Human-readable provider names, shown in the Pi model picker. */",
  "const TRAE_PROVIDER_DISPLAY_NAMES = {",
  "\tcn: \"Trae\",",
  "\tai: \"Trae Global\"",
  "};",
  "/** Region a provider route id belongs to. */",
  "function regionOfTraeProvider(provider) {",
  "\tfor (const [region, id] of Object.entries(TRAE_PROVIDERS)) if (id === provider) return region;",
  "}",
  "/**",
  " * Conservative context capacity used only when a served model row carries no",
  " * window of its own. Every fallback row and every live Trae row is expected to",
  " * state its real window; this is the backstop that keeps one unsized row from",
  " * failing the entire provider route (INVALID_MODEL_CONTEXT in DSH terms).",
  " */",
  "const FALLBACK_CONTEXT_WINDOW = 2e5;",
  "/** Idle ceiling while one stream read is outstanding. */",
  "const TRAE_STREAM_IDLE_TIMEOUT_MS = 3e5;",
  "export {",
  "  TraeCatalog,",
  "  TraeCredentialStore,",
  "  TraeDelegatingUpstreamClient,",
  "  TraeSoloBridge,",
  "  TraeSoloRemoteCatalogClient,",
  "  TraeSoloUpstreamClient,",
  "  REGION_GATEWAYS,",
  "  TRAE_CN_ENTERPRISE_BASE,",
  "  SseDecoder,",
  "  TRAE_AI_PROVIDER,",
  "  TRAE_CN_AGENT_TASK_PATH,",
  "  TRAE_CN_TITLE_PATH,",
  "  TRAE_PROVIDER,",
  "  TRAE_PROVIDERS,",
  "  TRAE_PROVIDER_DISPLAY_NAMES,",
  "  TRAE_SOLO_CHAT_PATH,",
  "  TRAE_SOLO_FUNCTION,",
  "  TRAE_SOLO_MODELS_PATH,",
  "  TRAE_SOLO_REMOTE_BASE,",
  "  TRAE_STATE_DB_FILENAME,",
  "  TRAE_STREAM_IDLE_TIMEOUT_MS,",
  "  TRAE_USAGE_PATH,",
  "  TRAE_CHECKIN_PATH,",
  "  TRAE_VERSION_CODE_FALLBACK,",
  "  traeWebUsage,",
  "  applyContextBudgets,",
  "  applyImageSelection,",
  "  applyReasoningEffort,",
  "  bridgeTraeSoloStream,",
  "  buildTraeAgentTaskBody,",
  "  buildTraeCnHeaders,",
  "  buildTraeRawChatDraft,",
  "  buildTraeRawChatRuntimeConfig,",
  "  CHECKIN_DEVICE_ALREADY_CLAIMED,",
  "  classifyTraeRawChatFailure,",
  "  createTraeShim,",
  "  decodeRawChatChunk,",
  "  decodeTraeEvent,",
  "  decryptTraeStorageValue,",
  "  deriveCatalog,",
  "  discoveredCatalog,",
  "  FALLBACK_TRAE_MODELS,",
  "  FALLBACK_TRAE_MODELS_AI,",
  "  fallbackModelsFor,",
  "  identityHeaders,",
  "  legacyTraeOwnAuthPath,",
  "  mergeTraeModelSources,",
  "  normalizeTraeCredential,",
  "  normalizeTraeVersionCode,",
  "  parseReasoningCapability,",
  "  parseTraeAuthValue,",
  "  parseTraeCachedModel,",
  "  parseTraeRemoteModel,",
  "  parseTraeStorageDocument,",
  "  parseUsageSnapshot,",
  "  pickTraeStorageIdentity,",
  "  prepareSoloBody,",
  "  readTraeCachedModel,",
  "  readTraeCliIdentity,",
  "  readTraeIdentity,",
  "  refreshTraeCredential,",
  "  regionOfCredential,",
  "  safeMessage,",
  "  toCheckin,",
  "  toCredits,",
  "  TraeUsageClient,",
  "  regionOfEdition,",
  "  regionOfHost,",
  "  regionOfTraeProvider,",
  "  regionOfUserRegion,",
  "  resolveTraeIdentity,",
  "  resolveTraeRawRuntime,",
  "  sanitizeCatalog,",
  "  traeEndpoint,",
  "  traeInputModalities,",
  "  traeModelDisplayName,",
  "  traeOwnAuthPath,",
  "  traeRawChatExtraInfo,",
  "  traeStateDatabaseCandidates,",
  "  traeStorageCandidates,",
  "  traeWindowsAppNames,",
  "  unwrapVolatile,",
  "  unwrapVolatileDeep,",
  "};",
  "//#endregion",
  "",
].join("\n");

mkdirSync(dirname(DST), { recursive: true });
writeFileSync(DST, out);
console.log(`wrote ${DST} (${out.split("\n").length} lines)`);

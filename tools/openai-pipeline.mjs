import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

// --- Configuration (override via CLI args: --host --port --token) ---
const args = process.argv.slice(2).reduce((acc, v, i, a) => {
  if (v.startsWith("--")) acc[v.slice(2)] = a[i + 1];
  return acc;
}, {});

const RESIN_HOST = args.host || "192.168.123.104";
const RESIN_PORT = args.port || 2260;
const ADMIN_TOKEN = args.token || "admin123";
const FETCH_CONCURRENCY = 30;
const OPENAI_CONCURRENCY = 20;
const BASIC_TIMEOUT = 6000;
const OPENAI_TIMEOUT = 10000;
const BASIC_TEST_URL = "http://httpbin.org/ip";
const SUBSCRIPTION_NAME = "openai-proxies";

const PROXY_SOURCES = [
  "https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt",
  "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt",
  "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/https.txt",
  "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-LIST/master/http.txt",
  "https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt",
  "https://proxy.scdn.io",
];

const OPENAI_TARGETS = [
  { name: "auth.openai.com", url: "https://auth.openai.com/.well-known/openid-configuration", expectStatus: [200] },
  { name: "chatgpt.com", url: "https://chatgpt.com/", expectStatus: [200, 301, 302, 403] },
  { name: "sentinel.openai.com", url: "https://sentinel.openai.com/", expectStatus: [200, 401, 403] },
];

// --- Utilities ---

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { timeout: 15000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function resinApi(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : "";
    const req = http.request({
      hostname: RESIN_HOST,
      port: RESIN_PORT,
      method,
      path,
      headers: {
        "Authorization": `Bearer ${ADMIN_TOKEN}`,
        "Content-Type": "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      },
      timeout: 10000,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try { resolve({ status: res.statusCode, data: JSON.parse(text) }); }
        catch { resolve({ status: res.statusCode, data: text }); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function runConcurrent(tasks, concurrency) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array(Math.min(concurrency, tasks.length)).fill(null).map(() => worker()));
  return results;
}

// --- Stage 1: Fetch proxy lists ---

function parseProxies(text) {
  const results = new Set();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = t.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)$/);
    if (m) results.add(`socks5://${m[1]}:${m[2]}`);
  }
  return [...results];
}

async function fetchProxyLists() {
  console.log("[1/4] Fetching proxy lists from public sources...");
  let allRaw = [];
  for (const src of PROXY_SOURCES) {
    try {
      const text = await fetchText(src);
      const proxies = parseProxies(text);
      console.log(`  ${src.split("/").pop()}: ${proxies.length} proxies`);
      allRaw.push(...proxies);
    } catch (e) {
      console.log(`  ${src.split("/").pop()}: FAILED (${e.message})`);
    }
  }
  const unique = [...new Set(allRaw)];
  console.log(`  Total unique: ${unique.length}\n`);
  return unique;
}

// --- Stage 2: Basic connectivity test ---

function testBasic(proxyUrl) {
  return new Promise((resolve) => {
    const u = new URL(proxyUrl);
    const targetUrl = new URL(BASIC_TEST_URL);
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    // SOCKS5: CONNECT tunnel
    const req = http.request({
      host: u.hostname,
      port: parseInt(u.port, 10),
      method: "CONNECT",
      path: `${targetUrl.hostname}:80`,
      timeout: BASIC_TIMEOUT,
      headers: { Host: `${targetUrl.hostname}:80` },
    });
    req.on("connect", (res, socket) => {
      if (res.statusCode === 200) {
        socket.write(`GET /ip HTTP/1.1\r\nHost: httpbin.org\r\nConnection: close\r\n\r\n`);
        let data = "";
        const timer = setTimeout(() => { socket.destroy(); done(false); }, 3000);
        socket.on("data", (c) => { data += c.toString(); });
        socket.on("end", () => { clearTimeout(timer); done(data.includes("origin") || data.includes("200 OK")); });
        socket.on("error", () => { clearTimeout(timer); done(false); });
      } else {
        done(false);
      }
    });
    req.on("error", () => done(false));
    req.on("timeout", () => { req.destroy(); done(false); });
    req.end();
  });
}

async function basicTest(proxies) {
  console.log(`[2/4] Basic connectivity test (concurrency=${FETCH_CONCURRENCY}, timeout=${BASIC_TIMEOUT}ms)...`);
  let tested = 0;
  const tasks = proxies.map((p) => async () => {
    const ok = await testBasic(p);
    tested++;
    if (tested % 20 === 0 || tested === proxies.length) {
      process.stdout.write(`  Progress: ${tested}/${proxies.length}\r`);
    }
    return ok ? p : null;
  });
  const results = await runConcurrent(tasks, FETCH_CONCURRENCY);
  const passing = results.filter(Boolean);
  console.log(`  Basic pass: ${passing.length}/${proxies.length}\n`);
  return passing;
}

// --- Stage 3: OpenAI connectivity test ---

function testOpenAITarget(proxyUrl, target) {
  return new Promise((resolve) => {
    const proxy = new URL(proxyUrl);
    const targetUrl = new URL(target.url);
    let settled = false;
    const done = (ok, detail) => { if (!settled) { settled = true; resolve({ ok, detail }); } };

    const connectReq = http.request({
      host: proxy.hostname,
      port: parseInt(proxy.port, 10),
      method: "CONNECT",
      path: `${targetUrl.hostname}:443`,
      timeout: OPENAI_TIMEOUT,
      headers: { Host: `${targetUrl.hostname}:443` },
    });

    connectReq.on("connect", (res, socket) => {
      if (res.statusCode !== 200) { done(false, `CONNECT ${res.statusCode}`); return; }
      const reqPath = targetUrl.pathname + targetUrl.search;
      socket.write(`GET ${reqPath} HTTP/1.1\r\nHost: ${targetUrl.hostname}\r\nConnection: close\r\n\r\n`);
      let data = "";
      const timer = setTimeout(() => { socket.destroy(); done(false, "response timeout"); }, 5000);
      socket.on("data", (c) => { data += c.toString(); });
      socket.on("end", () => {
        clearTimeout(timer);
        const m = data.match(/^HTTP\/[\d.]+\s+(\d+)/);
        if (m) {
          const status = parseInt(m[1], 10);
          done(target.expectStatus.includes(status), `HTTP ${status}`);
        } else {
          done(false, "no HTTP response");
        }
      });
      socket.on("error", (e) => { clearTimeout(timer); done(false, e.message); });
    });
    connectReq.on("error", (e) => done(false, e.message));
    connectReq.on("timeout", () => { connectReq.destroy(); done(false, "CONNECT timeout"); });
    connectReq.end();
  });
}

async function openaiTest(proxies) {
  console.log(`[3/4] OpenAI connectivity test (concurrency=${OPENAI_CONCURRENCY}, timeout=${OPENAI_TIMEOUT}ms)...`);
  console.log(`  Targets: ${OPENAI_TARGETS.map(t => t.name).join(", ")}`);

  let tested = 0;
  const tasks = proxies.map((p) => async () => {
    const targetResults = {};
    for (const target of OPENAI_TARGETS) {
      try {
        targetResults[target.name] = await testOpenAITarget(p, target);
      } catch (e) {
        targetResults[target.name] = { ok: false, detail: e.message };
      }
    }
    tested++;
    if (tested % 10 === 0 || tested === proxies.length) {
      process.stdout.write(`  Progress: ${tested}/${proxies.length}\r`);
    }
    return { proxy: p, targetResults };
  });

  const results = await runConcurrent(tasks, OPENAI_CONCURRENCY);
  const passing = results.filter(r => Object.values(r.targetResults).every(v => v.ok));
  const partial = results.filter(r => !Object.values(r.targetResults).every(v => v.ok) && Object.values(r.targetResults).some(v => v.ok));

  console.log(`\n  OpenAI all-pass: ${passing.length}, partial: ${partial.length}, fail: ${results.length - passing.length - partial.length}\n`);
  return [...passing, ...partial];
}

// --- Stage 4: Save to Resin ---

async function saveSubscription(proxies) {
  if (proxies.length === 0) {
    console.log("[4/4] No OpenAI-capable proxies found. Skipping import.\n");
    return;
  }

  console.log(`[4/4] Saving ${proxies.length} OpenAI-capable proxies as '${SUBSCRIPTION_NAME}'...`);
  const content = proxies.map(r => r.proxy).join("\n");

  try {
    // Try create
    const res = await resinApi("POST", "/api/v1/subscriptions", {
      name: SUBSCRIPTION_NAME,
      source_type: "local",
      content,
      update_interval: "5m",
      enabled: true,
    });

    if (res.status === 201) {
      console.log(`  Created subscription '${SUBSCRIPTION_NAME}': id=${res.data.id}`);
    } else {
      const msg = typeof res.data === "object" ? JSON.stringify(res.data) : String(res.data);
      if (msg.includes("already exists") || msg.includes("duplicate")) {
        // Find and update existing
        const listRes = await resinApi("GET", `/api/v1/subscriptions?keyword=${SUBSCRIPTION_NAME}`);
        if (listRes.status === 200 && listRes.data.items?.length > 0) {
          const subId = listRes.data.items[0].id;
          const patchRes = await resinApi("PATCH", `/api/v1/subscriptions/${subId}`, { content });
          if (patchRes.status === 200) {
            console.log(`  Updated subscription '${SUBSCRIPTION_NAME}': ${proxies.length} proxies`);
          } else {
            console.log(`  Update failed: ${JSON.stringify(patchRes.data)}`);
          }
        }
      } else {
        console.log(`  Create failed (${res.status}): ${msg}`);
      }
    }
  } catch (e) {
    console.log(`  API error: ${e.message}`);
  }
}

// --- Main ---

async function main() {
  const start = Date.now();
  console.log(`=== Resin OpenAI Proxy Pipeline ===`);
  console.log(`  Resin: ${RESIN_HOST}:${RESIN_PORT}`);
  console.log(`  Time: ${new Date().toISOString()}\n`);

  // Stage 1: Fetch
  const allProxies = await fetchProxyLists();
  if (allProxies.length === 0) { console.log("No proxies found. Exiting."); return; }

  // Stage 2: Basic test
  const basicPass = await basicTest(allProxies);
  if (basicPass.length === 0) { console.log("No working proxies. Exiting."); return; }

  // Stage 3: OpenAI test
  const openaiProxies = await openaiTest(basicPass);

  // Stage 4: Save
  await saveSubscription(openaiProxies);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nPipeline complete in ${elapsed}s: ${allProxies.length} fetched -> ${basicPass.length} basic -> ${openaiProxies.length} OpenAI-capable`);
}

main().catch(console.error);
process.on("uncaughtException", () => {});

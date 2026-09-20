"use strict";
/* DIXON backend: static site + JSON API. Zero dependencies.
 * Run:  node server.js            (PORT env, default 8099)
 * Admin token: ADMIN_TOKEN env, default "dixon-12345" (change it!).
 * Local secrets: copy .env.example to .env (gitignored, never commit).
 */
try { // minimal .env loader (no deps): KEY=VALUE lines, env wins
  const dotEnv = require("fs").readFileSync(require("path").join(__dirname, ".env"), "utf8");
  for (const line of dotEnv.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
} catch (e) {}
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8099);
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || "dixon-12345").trim();
const CORS_LIST = (process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
function applyCors(req, res) {
  const o = req.headers.origin;
  if (o && (CORS_LIST.includes("*") || CORS_LIST.includes(o))) {
    res.setHeader("Access-Control-Allow-Origin", o);
    res.setHeader("Vary", "Origin");
  }
}
const ROOT = path.join(__dirname, "public");
const DATA = process.env.DATA_DIR || path.join(__dirname, "data");
const LEADS_FILE = path.join(DATA, "leads.json");
const STARTED_AT = Date.now();

const TOPICS = ["Разбит экран", "Аккумулятор", "Корпус / крышка", "Не заряжается / разъём", "Другое"];

// Mirror of the price table on the site (rubles, work included).
// Bump PRICES_UPDATED whenever prices change — the site shows it.
const PRICES_FILE = path.join(DATA, "prices.json");
const PRICES_DEFAULT_UPDATED = "2026-09-20";
let PRICES = [
  { model: "A15 SM-A155F", group: "A", display: 5500, battery: 4200, back: 2100 },
  { model: "A25 SM-A256E", group: "A", display: 6800, battery: 4400, back: 2200 },
  { model: "A35 SM-A356E", group: "A", display: 8200, battery: 4600, back: 2600 },
  { model: "A55 SM-A556E (без рамы)", group: "A", display: 8900, battery: 5200, back: 3200 },
  { model: "A55 SM-A556E (с рамой)", group: "A", display: 12300, battery: 5200, back: 3200 },
  { model: "S23 SM-S911B (с рамой)", group: "S", display: 16500, battery: 6300, back: 4600 },
  { model: "S23 Ultra (без рамы)", group: "S", display: 21500, battery: 6500, back: 6400 },
  { model: "S24 SM-S921B (без рамы)", group: "S", display: 13500, battery: 6400, back: 4900 },
  { model: "S24 Ultra (без рамы)", group: "S", display: 21500, battery: 6200, back: 5400 },
  { model: "S25 Ultra Black (без рамы)", group: "S", display: 20500, battery: 7400, back: 7500 },
  { model: "Z Flip 5 SM-F731B", group: "Z", display: 30200, battery: 10500, back: 4600, note: "battery = pair" },
  { model: "Z Fold 5 SM-F946B", group: "Z", display: 53500, battery: 10500, back: 6000, note: "battery = pair" },
  { model: "Z Fold 6 SM-F956B", group: "Z", display: 55000, battery: 10500, back: 6200, note: "battery = pair" }
];
let PRICES_UPDATED = PRICES_DEFAULT_UPDATED;
try {
  const custom = JSON.parse(fs.readFileSync(PRICES_FILE, "utf8"));
  if (custom && Array.isArray(custom.prices) && custom.prices.length > 0) {
    PRICES = custom.prices;
    if (custom.updated) PRICES_UPDATED = custom.updated;
  }
} catch (e) {}
function savePrices() {
  fs.writeFileSync(PRICES_FILE, JSON.stringify({ updated: PRICES_UPDATED, prices: PRICES }, null, 2));
}
function todayMSK() {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()).split(".").reverse().join("-");
}
function validPrices(p) {
  if (!Array.isArray(p) || p.length === 0 || p.length > 500) return false;
  return p.every((r) => r && typeof r.model === "string" && r.model.trim().length > 0 && r.model.length <= 80 &&
    ["A", "S", "Z"].includes(r.group) &&
    ["display", "battery", "back"].every((k) => Number.isInteger(r[k]) && r[k] >= 0 && r[k] <= 500000));
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webm": "video/webm"
};

// ---- storage: Supabase (online) or local SQLite (fallback, needs volume on prod) ----
const SUPA_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPA_KEY = (process.env.SUPABASE_KEY || "").trim();
const useSupa = !!(SUPA_URL && SUPA_KEY);
function supa(path, opts) {
  opts = opts || {};
  opts.headers = Object.assign({ apikey: SUPA_KEY, Authorization: "Bearer " + SUPA_KEY, "Content-Type": "application/json", Prefer: "return=representation" }, opts.headers || {});
  return fetch(SUPA_URL + "/rest/v1/leads" + (path || ""), opts).then((r) => {
    if (!r.ok) throw new Error("supabase " + r.status);
    return r.json().catch(() => null);
  });
}
let lite = null; // node:sqlite handle (fallback only)
function liteDb() {
  if (lite) return lite;
  const { DatabaseSync } = require("node:sqlite");
  fs.mkdirSync(DATA, { recursive: true });
  lite = new DatabaseSync(path.join(DATA, "dixon.db"));
  lite.exec("CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL, topic TEXT NOT NULL, accepted INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0)");
  return lite;
}
function liteRow(r) { return r && { id: r.id, ts: r.ts, name: r.name, phone: r.phone, topic: r.topic, accepted: !!r.accepted, done: !!r.done }; }
async function dbAll() {
  if (useSupa) return (await supa("?select=*&order=id.asc")) || [];
  return liteDb().prepare("SELECT * FROM leads ORDER BY id ASC").all().map(liteRow);
}
async function dbGet(id) {
  if (useSupa) { const r = await supa("?select=*&id=eq." + id); return (r && r[0]) || null; }
  return liteRow(liteDb().prepare("SELECT * FROM leads WHERE id=?").get(id));
}
async function dbAdd(entry) {
  if (useSupa) { const r = await supa("", { method: "POST", body: JSON.stringify({ ts: entry.ts, name: entry.name, phone: entry.phone, topic: entry.topic, accepted: false, done: false }) }); return r && r[0]; }
  const q = liteDb().prepare("INSERT INTO leads (ts,name,phone,topic,accepted,done) VALUES (?,?,?,?,0,0)").run(entry.ts, entry.name, entry.phone, entry.topic);
  return dbGet(Number(q.lastInsertRowid));
}
async function dbSet(id, patch) {
  const body = {};
  if ("accepted" in patch) body.accepted = !!patch.accepted;
  if ("done" in patch) body.done = !!patch.done;
  if (useSupa) { const r = await supa("?id=eq." + id, { method: "PATCH", body: JSON.stringify(body) }); return r && r[0]; }
  const cur = await dbGet(id);
  if (!cur) return null;
  liteDb().prepare("UPDATE leads SET accepted=?, done=? WHERE id=?").run(
    body.accepted !== undefined ? (body.accepted ? 1 : 0) : (cur.accepted ? 1 : 0),
    body.done !== undefined ? (body.done ? 1 : 0) : (cur.done ? 1 : 0), id);
  return dbGet(id);
}
async function dbDel(id) {
  if (useSupa) { await supa("?id=eq." + id, { method: "DELETE", headers: { Prefer: "return=minimal" } }); return; }
  liteDb().prepare("DELETE FROM leads WHERE id=?").run(id);
}
async function dbDupe(phone, topic) {
  if (useSupa) { const r = await supa("?select=id,ts&phone=eq." + encodeURIComponent(phone) + "&topic=eq." + encodeURIComponent(topic) + "&order=id.desc&limit=1"); return (r && r[0]) || null; }
  return liteDb().prepare("SELECT id,ts FROM leads WHERE phone=? AND topic=? ORDER BY id DESC LIMIT 1").get(phone, topic) || null;
}
(async function importLegacy() { // one-time: leads.json -> active backend
  try {
    if ((await dbAll()).length) return;
    const old = JSON.parse(fs.readFileSync(LEADS_FILE, "utf8"));
    if (!Array.isArray(old) || !old.length) return;
    for (const l of old) {
      try {
        const row = await dbAdd({ ts: l.ts || new Date().toISOString(), name: String(l.name || "").slice(0, 60), phone: l.phone, topic: l.topic });
        if (row && (l.accepted || l.done)) await dbSet(row.id, { accepted: !!l.accepted, done: !!l.done });
      } catch (e) {}
    }
    try { fs.renameSync(LEADS_FILE, LEADS_FILE + ".imported"); } catch (e) {}
  } catch (e) {}
})();
const SEC_HEADERS = { "X-Content-Type-Options": "nosniff", "X-Frame-Options": "SAMEORIGIN", "Referrer-Policy": "no-referrer" };
// Strict CSP: only own files + hashed inline scripts/styles (computed at boot).
function pageCspHashes() {
  const scripts = [], styles = [];
  let dir = [];
  try { dir = fs.readdirSync(ROOT); } catch (e) { return { scripts, styles }; }
  for (const f of dir) {
    if (!f.endsWith(".html")) continue;
    let html = "";
    try { html = fs.readFileSync(path.join(ROOT, f), "utf8"); } catch (e) { continue; }
    const reJs = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
    const reCss = /<style[^>]*>([\s\S]*?)<\/style>/g;
    let m;
    while ((m = reJs.exec(html))) {
      if (!m[1].trim()) continue;
      scripts.push("'sha256-" + crypto.createHash("sha256").update(m[1], "utf8").digest("base64") + "'");
    }
    while ((m = reCss.exec(html))) {
      if (!m[1].trim()) continue;
      styles.push("'sha256-" + crypto.createHash("sha256").update(m[1], "utf8").digest("base64") + "'");
    }
  }
  return { scripts, styles };
}
const _cspHashes = pageCspHashes();
const CSP = "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; img-src 'self' data:; font-src 'self' https://fonts.gstatic.com; connect-src 'self' data: https://fonts.googleapis.com https://fonts.gstatic.com; style-src 'self' https://fonts.googleapis.com " + _cspHashes.styles.join(" ") + "; script-src 'self' " + _cspHashes.scripts.join(" ");

// ---- realtime: server-sent events for admin ----
const sseClients = new Set();
function broadcast(type, data) {
  const msg = "event: " + type + "\ndata: " + JSON.stringify(data) + "\n\n";
  for (const r of [...sseClients]) {
    try { r.write(msg); } catch (e) { sseClients.delete(r); }
  }
}

// ---- telegram two-way sync (zero deps, long-poll) ----
function tgApi(method, payload) {
  if (!process.env.TG_BOT) return Promise.resolve(null);
  return fetch("https://api.telegram.org/bot" + process.env.TG_BOT + "/" + method, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  }).then((r) => r.json().catch(() => null)).catch(() => null);
}
function tgNotify(lead) {
  if (!process.env.TG_BOT || !process.env.TG_CHAT) return;
  tgApi("sendMessage", {
    chat_id: process.env.TG_CHAT,
    text: "🆕 Заявка #" + lead.id + "\n👤 " + lead.name + "\n📞 " + lead.phone + "\n🛠 " + lead.topic,
    reply_markup: { inline_keyboard: [[{ text: "✅ Принять", callback_data: "accept:" + lead.id }]] },
  });
}
let tgOffset = 0;
async function tgPollOnce() {
  let data = null;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 32000);
    const r = await fetch("https://api.telegram.org/bot" + process.env.TG_BOT + "/getUpdates", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ offset: tgOffset, timeout: 25, allowed_updates: ["callback_query"] }),
      signal: ctl.signal,
    });
    clearTimeout(timer);
    data = await r.json().catch(() => null);
  } catch (e) { data = null; }
  if (!data || !data.ok) return false;
  for (const u of (data.result || [])) {
    tgOffset = u.update_id + 1;
    const cb = u.callback_query;
    if (!cb || typeof cb.data !== "string") continue;
    const m = /^accept:(\d+)$/.exec(cb.data);
    if (!m) { tgApi("answerCallbackQuery", { callback_query_id: cb.id, text: "?" }); continue; }
    const lead = await dbGet(Number(m[1]));
    if (!lead) { tgApi("answerCallbackQuery", { callback_query_id: cb.id, text: "Заявка не найдена" }); continue; }
    if (lead.done) { tgApi("answerCallbackQuery", { callback_query_id: cb.id, text: "Уже завершена" }); continue; }
    if (lead.accepted) { tgApi("answerCallbackQuery", { callback_query_id: cb.id, text: "Уже принята" }); continue; }
    await dbSet(lead.id, { accepted: true });
    broadcast("lead:update", { id: lead.id, accepted: true });
    tgApi("answerCallbackQuery", { callback_query_id: cb.id, text: "Принята ✅" });
    if (cb.message) {
      tgApi("editMessageReplyMarkup", { chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
    }
  }
  return true;
}
async function tgPollLoop() {
  try { // discard backlog from downtime so old buttons don't spam
    const r = await tgApi("getUpdates", { timeout: 0 });
    if (r && r.ok && Array.isArray(r.result) && r.result.length) tgOffset = r.result[r.result.length - 1].update_id + 1;
  } catch (e) {}
  for (;;) {
    const ok = await tgPollOnce();
    if (!ok) await new Promise((r) => setTimeout(r, 5000));
  }
}

// ---- rate limit: 20 POST /api/lead per IP per minute ----
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 20;
}

// ---- helpers ----
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) }, SEC_HEADERS));
  res.end(body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("too-big")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function normalizePhone(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.startsWith("8")) d = "7" + d.slice(1);
  if (d && !d.startsWith("7")) d = "7" + d;
  return /^7\d{10}$/.test(d) ? "+" + d : null;
}
// brute-force guard for admin endpoints: 10 bad tries -> 10 min lockout per IP
const authFails = new Map();
function requireAdmin(req, url, res, ip, allowQuery) {
  const f = authFails.get(ip);
  if (f && f.until > Date.now()) return (send(res, 429, { ok: false, error: "locked" }), false);
  const h = req.headers["x-admin-token"];
  const q = allowQuery ? url.searchParams.get("token") : null;
  if (h === ADMIN_TOKEN || q === ADMIN_TOKEN) { authFails.delete(ip); return true; }
  const n = (f ? f.n : 0) + 1;
  authFails.set(ip, n >= 10 ? { n: 0, until: Date.now() + 10 * 60 * 1000 } : { n, until: 0 });
  send(res, 403, { ok: false, error: "forbidden" });
  return false;
}
function serveStatic(req, res, pathname) {
  let p = decodeURIComponent(pathname);
  if (p === "/") p = "/index.html";
  if (p === "/favicon.ico") p = "/icon.svg";
  const f = path.normalize(path.join(ROOT, p));
  if (!f.startsWith(ROOT)) { res.writeHead(403); res.end("no"); return; }
  fs.readFile(f, (e, d) => {
    if (e) {
      if (pathname.startsWith("/api/")) return send(res, 404, { ok: false, error: "not found" });
      fs.readFile(path.join(ROOT, "404.html"), (e2, d2) => {
        if (e2) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("404"); return; }
        res.writeHead(404, Object.assign({ "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": CSP }, SEC_HEADERS));
        res.end(d2);
      });
      return;
    }
    const ext = path.extname(f);
    const headers = Object.assign({ "Content-Type": MIME[ext] || "application/octet-stream" }, SEC_HEADERS);
    if (ext === ".html") headers["Content-Security-Policy"] = CSP;
    if (ext === ".html") headers["Cache-Control"] = "no-store";
    res.writeHead(200, headers);
    res.end(d);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const ip = req.socket.remoteAddress || "?";
  applyCors(req, res);
  const t0 = Date.now();
  res.on("finish", () => {
    console.log(new Date().toISOString(), req.method, url.pathname, res.statusCode, (Date.now() - t0) + "ms", ip);
  });
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token", "Access-Control-Max-Age": "86400" });
      res.end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      let n = -1;
      try { n = (await dbAll()).length; } catch (e) {}
      return send(res, 200, { ok: true, time: new Date().toISOString(), uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000), leads: n, db: useSupa ? "supabase" : "sqlite" });
    }
    if (req.method === "GET" && url.pathname === "/api/prices") {
      return send(res, 200, { ok: true, updated: PRICES_UPDATED, prices: PRICES });
    }
    if (req.method === "POST" && url.pathname === "/api/lead") {
      if (rateLimited(ip)) return send(res, 429, { ok: false, error: "Слишком много заявок. Попробуйте через минуту." });
      let body;
      try { body = JSON.parse(await readBody(req, 20 * 1024)); }
      catch (e) { return send(res, 400, { ok: false, error: "Некорректный запрос." }); }
      const name = String(body.name || "").trim();
      const topic = String(body.topic || "").trim();
      const phone = normalizePhone(body.phone);
      if (name.length < 2 || name.length > 60) return send(res, 400, { ok: false, error: "Укажите имя (2–60 символов)." });
      if (!phone) return send(res, 400, { ok: false, error: "Проверьте номер телефона." });
      if (!TOPICS.includes(topic)) return send(res, 400, { ok: false, error: "Выберите тему обращения." });
      if (body.consent !== true) return send(res, 400, { ok: false, error: "Нужно согласие на обработку данных." });
      if (String(body.company || "").trim() !== "") return send(res, 200, { ok: true, id: 0, quiet: true }); // honeypot: pretend success
      let lead;
      try {
        const dupe = await dbDupe(phone, topic);
        if (dupe && (Date.now() - new Date(dupe.ts).getTime()) < 10 * 60 * 1000) return send(res, 200, { ok: true, id: dupe.id, duplicate: true });
        lead = await dbAdd({ ts: new Date().toISOString(), name, phone, topic });
        if (!lead) throw new Error("db");
      } catch (e) { return send(res, 500, { ok: false, error: "Не получилось сохранить. Позвоните нам: 8 (8352) 36-42-02." }); }
      broadcast("lead:new", { id: lead.id, name, phone, topic, ts: lead.ts });
      tgNotify(lead);
      return send(res, 200, { ok: true, id: lead.id });
    }
    if (req.method === "GET" && url.pathname === "/api/leads") {
      if (!requireAdmin(req, url, res, ip)) return;
      return send(res, 200, { ok: true, leads: (await dbAll()).reverse() });
    }
    if (req.method === "PATCH" && url.pathname.startsWith("/api/leads/")) {
      if (!requireAdmin(req, url, res, ip)) return;
      const id = Number(url.pathname.split("/").pop());
      const lead = await dbGet(id);
      if (!lead) return send(res, 404, { ok: false, error: "not found" });
      let body;
      try { body = JSON.parse(await readBody(req, 1024)); }
      catch (e) { return send(res, 400, { ok: false, error: "bad body" }); }
      const updated = await dbSet(id, body);
      if (!updated) return send(res, 404, { ok: false, error: "not found" });
      broadcast("lead:update", { id: updated.id, accepted: updated.accepted, done: updated.done });
      return send(res, 200, { ok: true, lead: updated });
    }
    if (req.method === "GET" && url.pathname === "/api/stats") {
      if (!requireAdmin(req, url, res, ip)) return;
      const today = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      const byTopic = {};
      let open = 0, accepted = 0, todayN = 0;
      const rows = await dbAll();
      for (const l of rows) {
        if (l.done) {} else open++;
        if (l.accepted && !l.done) accepted++;
        byTopic[l.topic] = (byTopic[l.topic] || 0) + 1;
        try {
          const d = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(l.ts));
          if (d === today) todayN++;
        } catch (e) {}
      }
      return send(res, 200, { ok: true, total: rows.length, open, accepted, done: rows.length - open, today: todayN, byTopic });
    }
    if (req.method === "GET" && url.pathname === "/api/leads.csv") {
      if (!requireAdmin(req, url, res, ip)) return;
      const esc = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
      const rows = ["id,ts,name,phone,topic,done"];
      for (const l of (await dbAll()).reverse()) rows.push([l.id, l.ts, esc(l.name), l.phone, esc(l.topic), l.done ? 1 : 0].join(","));
      const body = "﻿" + rows.join("\r\n");
      res.writeHead(200, Object.assign({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="dixon-leads.csv"', "Content-Length": Buffer.byteLength(body) }, SEC_HEADERS));
      return res.end(body);
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/leads/")) {
      if (!requireAdmin(req, url, res, ip)) return;
      const id = Number(url.pathname.split("/").pop());
      const lead = await dbGet(id);
      if (!lead) return send(res, 404, { ok: false, error: "not found" });
      await dbDel(id);
      broadcast("lead:delete", { id });
      return send(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/events") {
      if (!requireAdmin(req, url, res, ip, true)) return; // EventSource cannot send headers: query token only here
      res.writeHead(200, Object.assign({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "Connection": "keep-alive" }, SEC_HEADERS));
      res.write(": connected\n\n");
      sseClients.add(res);
      const hb = setInterval(() => { try { res.write(": ping\n\n"); } catch (e) { clearInterval(hb); sseClients.delete(res); } }, 25000);
      req.on("close", () => { clearInterval(hb); sseClients.delete(res); });
      return;
    }
    if (req.method === "PUT" && url.pathname === "/api/prices") {
      if (!requireAdmin(req, url, res, ip)) return;
      let body;
      try { body = JSON.parse(await readBody(req, 100 * 1024)); }
      catch (e) { return send(res, 400, { ok: false, error: "bad body" }); }
      if (!validPrices(body.prices)) return send(res, 400, { ok: false, error: "bad prices" });
      PRICES = body.prices.map((r) => ({ model: r.model.trim(), group: r.group, display: r.display, battery: r.battery, back: r.back }));
      PRICES_UPDATED = todayMSK();
      savePrices();
      broadcast("prices:update", { updated: PRICES_UPDATED });
      return send(res, 200, { ok: true, updated: PRICES_UPDATED });
    }
    if (req.method === "GET") return serveStatic(req, res, url.pathname);
    return send(res, 405, { ok: false, error: "method not allowed" });
  } catch (e) {
    console.error("handler error:", e);
    return send(res, 500, { ok: false, error: "internal error" });
  }
});

if (ADMIN_TOKEN === "dixon-12345") console.log("WARNING: default ADMIN_TOKEN in use — set a strong ADMIN_TOKEN env on any public server!");
console.log("Storage: " + (useSupa ? "supabase" : "sqlite (local fallback)"));
if (process.env.TG_BOT && process.env.TG_CHAT) { tgPollLoop(); console.log("Telegram sync on"); }
server.listen(PORT, process.env.HOST || "127.0.0.1", () => console.log("DIXON backend on http://127.0.0.1:" + PORT + " (public/, data/)"));

"use strict";

const assert = require("node:assert/strict");
const { once } = require("node:events");
const { Readable, Writable } = require("node:stream");
const test = require("node:test");
const mongodb = require("mongodb");
const { createDatabase } = require("./helpers/mongo-fixture");
const db = createDatabase();
const descriptor = Object.getOwnPropertyDescriptor(mongodb, "MongoClient");
Object.defineProperty(mongodb, "MongoClient", { configurable: true, value: class {
  async connect() {}
  db() { return db; }
  async close() {}
} });
const { sameOrigin } = require("../api/_mongo-auth");
const { handleRequest } = require("../server");
const names = ["AUTH_PROVIDER", "MONGODB_URI", "MONGODB_DATABASE", "PUBLIC_APP_URL", "AUTH_OTP_SECRET",
  "NODE_ENV", "VERCEL_ENV", "VERCEL", "VERCEL_URL", "VERCEL_PROJECT_PRODUCTION_URL", "RENDER"];
const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
test.beforeEach(() => {
  db.reset();
  for (const name of ["VERCEL_ENV", "VERCEL", "VERCEL_URL", "VERCEL_PROJECT_PRODUCTION_URL", "RENDER"]) delete process.env[name];
  Object.assign(process.env, { AUTH_PROVIDER: "mongodb", MONGODB_URI: "mongodb://fixture.invalid",
    MONGODB_DATABASE: "fixture", AUTH_OTP_SECRET: "a".repeat(64), NODE_ENV: "development",
    PUBLIC_APP_URL: "http://127.0.0.1:10000" });
});
test.after(() => {
  Object.defineProperty(mongodb, "MongoClient", descriptor);
  for (const name of names) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

function request({ origin = "http://localhost:10000", host = "localhost:10000",
  peer = "127.0.0.1", site = "same-origin", ...headers } = {}) {
  return { headers: { origin, host, "sec-fetch-site": site, ...headers }, socket: { remoteAddress: peer } };
}
async function invoke(url, { method = "GET", body, cookie = "", ...settings } = {}) {
  const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), request(settings));
  req.method = method;
  req.url = url;
  Object.assign(req.headers, { "content-type": "application/json", cookie });
  const chunks = [];
  const headers = {};
  const res = new Writable({ write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  res.statusCode = 200;
  res.setHeader = (name, value) => { headers[name.toLowerCase()] = value; };
  res.hasHeader = name => Object.hasOwn(headers, name.toLowerCase());
  const finished = once(res, "finish");
  await handleRequest(req, res);
  await finished;
  return { status: res.statusCode, headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
}
function cookie(result) { return result.headers["set-cookie"][0].split(";")[0]; }

test("local signup accepts the actual loopback website host and port rather than only the configured IP alias", () => {
  for (const settings of [
    {},
    { origin: "http://localhost:3000", host: "localhost:3000" },
    { origin: "http://[::1]:10000", host: "[::1]:10000", peer: "::1" },
    { peer: "::ffff:127.0.0.1" },
  ]) assert.equal(sameOrigin(request(settings)), true, JSON.stringify(settings));
  process.env.PUBLIC_APP_URL = "http://localhost:10000";
  assert.equal(sameOrigin(request({ origin: "http://127.0.0.1:10000", host: "127.0.0.1:10000" })), true);
});

test("local convenience rejects cross-site, other-port, forged-host and nonlocal requests", () => {
  for (const settings of [
    { origin: "https://attacker.invalid" },
    { origin: "http://localhost:3000", host: "localhost:10000", site: "same-site" },
    { origin: "http://127.0.0.1:3000", site: "same-site" },
    { host: "127.0.0.1:10000" },
    { host: "attacker.invalid", "x-forwarded-host": "localhost:10000" },
    { host: "localhost:10000@attacker.invalid" },
    { host: "localhost:10000/path" },
    { origin: null }, { origin: "null" }, { origin: "http://localhost:10000/" },
    { peer: "192.0.2.1" }, { site: "cross-site" },
  ]) assert.equal(sameOrigin(request(settings)), false, JSON.stringify(settings));
  const missingOrigin = request();
  delete missingOrigin.headers.origin;
  assert.equal(sameOrigin(missingOrigin), false);
});

test("deployed sites retain exact configured origins and never enable the loopback convenience", () => {
  for (const [name, value] of [["NODE_ENV", "production"], ["VERCEL_ENV", "production"],
    ["VERCEL", "1"], ["RENDER", "true"]]) {
    const previous = process.env[name];
    process.env[name] = value;
    assert.equal(sameOrigin(request()), false, name);
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
  process.env.NODE_ENV = "production";
  process.env.PUBLIC_APP_URL = "https://kr7tech.test";
  assert.equal(sameOrigin(request({ origin: "https://kr7tech.test", host: "kr7tech.test", peer: "192.0.2.1" })), true);
  assert.equal(sameOrigin(request({ origin: "https://www.kr7tech.test", host: "www.kr7tech.test" })), false);
  assert.equal(sameOrigin(request()), false);
});

test("server signup, session, sign-out and saved-credential login work from localhost with an IP-configured app URL", async () => {
  const password = "a memorable test passphrase";
  const created = await invoke("/api/account-auth", { method: "POST",
    body: { action: "signup", username: "Learner", password } });
  assert.equal(created.status, 201, created.body.error);
  assert.equal(db.collection("users").rows.length, 1);
  assert.match(db.collection("users").rows[0].passwordHash, /^scrypt-v2:/);
  const accountId = created.body.user.id;
  const signedIn = await invoke("/api/session", { cookie: cookie(created) });
  assert.equal(signedIn.body.signedIn, true);
  assert.equal(signedIn.body.user.id, accountId);
  assert.equal(signedIn.body.plan, "Free");
  const signedOut = await invoke("/api/session", { method: "DELETE", cookie: cookie(created) });
  assert.equal(signedOut.status, 200);
  assert.equal((await invoke("/api/session", { cookie: cookie(created) })).body.signedIn, false);
  const login = await invoke("/api/account-auth", { method: "POST",
    body: { action: "login", username: "LEARNER", password } });
  assert.equal(login.status, 200, login.body.error);
  assert.equal((await invoke("/api/session", { cookie: cookie(login) })).body.user.id, accountId);
  assert.equal(db.collection("users").rows.length, 1);
});

test("the server still rejects a different browser origin before any account is created", async () => {
  const result = await invoke("/api/account-auth", { method: "POST", origin: "http://localhost:3000",
    body: { action: "signup", username: "Learner", password: "a memorable test passphrase" } });
  assert.equal(result.status, 403);
  assert.match(result.body.error, /Submit this request from the KR7Tech website/);
  assert.equal(db.collection("users").rows.length, 0);
  assert.equal(db.collection("auth_rate_limits").rows.length, 0);
});

test("Vercel signup works on the current deployment URL as well as the configured production origin", async () => {
  Object.assign(process.env, { NODE_ENV: "production", VERCEL: "1", VERCEL_ENV: "production",
    PUBLIC_APP_URL: "https://kr7tech.test", VERCEL_URL: "kr7tech-build.vercel.app" });
  const result = await invoke("/api/account-auth", { method: "POST",
    origin: "https://kr7tech-build.vercel.app", host: "kr7tech-build.vercel.app",
    body: { action: "signup", username: "Learner", password: "a memorable test passphrase" } });
  assert.equal(result.status, 201, result.body.error);
  assert.match(result.headers["set-cookie"][0], /^__Host-kr7_session=.*; Secure$/);
  assert.equal((await invoke("/api/session", { cookie: cookie(result),
    origin: "https://kr7tech-build.vercel.app", host: "kr7tech-build.vercel.app" })).body.signedIn, true);
});

test("signup accepts a database named in the MongoDB URI without a duplicate database variable", async () => {
  process.env.MONGODB_URI = "mongodb://fixture.invalid/learners";
  delete process.env.MONGODB_DATABASE;
  const result = await invoke("/api/account-auth", { method: "POST",
    body: { action: "signup", username: "Learner", password: "a memorable test passphrase" } });
  assert.equal(result.status, 201, result.body.error);
  assert.equal((await invoke("/api/session", { cookie: cookie(result) })).body.signedIn, true);
});

test("Vercel can use its trusted production or preview URL when PUBLIC_APP_URL is unset", async () => {
  delete process.env.PUBLIC_APP_URL;
  Object.assign(process.env, { NODE_ENV: "production", VERCEL: "1", VERCEL_ENV: "production",
    VERCEL_URL: "kr7tech-build.vercel.app", VERCEL_PROJECT_PRODUCTION_URL: "kr7tech.test" });
  const result = await invoke("/api/account-auth", { method: "POST",
    origin: "https://kr7tech.test", host: "kr7tech.test",
    body: { action: "signup", username: "Learner", password: "a memorable test passphrase" } });
  assert.equal(result.status, 201, result.body.error);
  process.env.VERCEL_ENV = "preview";
  assert.equal(sameOrigin(request({ origin: "https://kr7tech-build.vercel.app" })), true);
  assert.equal(sameOrigin(request({ origin: "https://kr7tech.test" })), false);
});

test("Vercel origins never trust arbitrary request hosts, other deployments or invalid explicit configuration", () => {
  Object.assign(process.env, { NODE_ENV: "production", VERCEL: "1", VERCEL_ENV: "production",
    PUBLIC_APP_URL: "https://kr7tech.test", VERCEL_URL: "kr7tech-build.vercel.app" });
  for (const settings of [
    { origin: "https://another-build.vercel.app", host: "another-build.vercel.app" },
    { origin: "https://kr7tech-build.vercel.app.attacker.invalid", host: "kr7tech-build.vercel.app.attacker.invalid" },
    { origin: "https://attacker.invalid", host: "attacker.invalid", "x-forwarded-host": "kr7tech-build.vercel.app" },
    { origin: "https://kr7tech-build.vercel.app", site: "cross-site" },
    { origin: "http://kr7tech-build.vercel.app" },
    { origin: "null" },
  ]) assert.equal(sameOrigin(request(settings)), false, JSON.stringify(settings));
  process.env.PUBLIC_APP_URL = "http://localhost:10000";
  assert.equal(sameOrigin(request({ origin: "https://kr7tech-build.vercel.app" })), false);
  delete process.env.PUBLIC_APP_URL;
  process.env.VERCEL_URL = "kr7tech-build.vercel.app/invalid-path";
  process.env.VERCEL_ENV = "preview";
  assert.equal(sameOrigin(request({ origin: "https://kr7tech-build.vercel.app" })), false);
  delete process.env.VERCEL;
  process.env.VERCEL_URL = "kr7tech-build.vercel.app";
  assert.equal(sameOrigin(request({ origin: "https://kr7tech-build.vercel.app" })), false);
});

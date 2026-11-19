"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const mongodb = require("mongodb");
const descriptor = Object.getOwnPropertyDescriptor(mongodb, "MongoClient");
let nestedTlsFailure = false;
Object.defineProperty(mongodb, "MongoClient", { configurable: true, value: class {
  async connect() {
    const error = new Error("private connection details must not reach the browser");
    error.name = "MongoServerSelectionError";
    error.reason = { servers: new Map([["fixture", { error: Object.assign(new Error("private network detail"), {
      ...(nestedTlsFailure ? { cause: { code: "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR" } } : { code: "ETIMEDOUT" }),
    }) }]]) };
    throw error;
  }
  async close() {}
} });
const handler = require("../api/account-auth");
const names = ["AUTH_PROVIDER", "MONGODB_URI", "MONGODB_DATABASE", "PUBLIC_APP_URL", "AUTH_OTP_SECRET"];
const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
test.after(() => {
  Object.defineProperty(mongodb, "MongoClient", descriptor);
  for (const name of names) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

test("unreachable MongoDB explains signup failure without a successful response, cookie, or private details", async () => {
  Object.assign(process.env, { AUTH_PROVIDER: "mongodb", MONGODB_URI: "mongodb://fixture.invalid",
    MONGODB_DATABASE: "fixture", AUTH_OTP_SECRET: "a".repeat(64), PUBLIC_APP_URL: "https://kr7tech.test" });
  const res = { headers: {}, setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  const errors = [];
  const log = console.error;
  console.error = (...values) => errors.push(values);
  try {
    await handler({ method: "POST", headers: { origin: "https://kr7tech.test" },
      socket: { remoteAddress: "127.0.0.1" },
      body: { action: "signup", username: "Learner", password: "a memorable test passphrase" } }, res);
  } finally {
    console.error = log;
  }
  assert.equal(res.statusCode, 503);
  assert.match(res.body.error, /cannot connect to MongoDB/);
  assert.deepEqual(errors, [["Account auth MongoDB connection failed.", "ETIMEDOUT"]]);
  assert.equal(res.body.signedIn, undefined);
  assert.equal(res.headers["set-cookie"], undefined);
  assert.doesNotMatch(JSON.stringify(res.body), /private connection details|memorable test passphrase/);
});

test("nested TLS failures retain a useful sanitized code instead of the string undefined", async () => {
  nestedTlsFailure = true;
  Object.assign(process.env, { AUTH_PROVIDER: "mongodb", MONGODB_URI: "mongodb://fixture.invalid",
    MONGODB_DATABASE: "fixture" });
  await assert.rejects(require("../api/_mongo").connect(), error => {
    assert.equal(error.code, "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR");
    assert.equal(error.message, "MongoDB account storage is unavailable.");
    return true;
  });
});

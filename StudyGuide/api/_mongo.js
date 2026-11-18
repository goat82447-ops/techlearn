"use strict";

let connection;

function mongoEnabled() {
  return process.env.AUTH_PROVIDER === "mongodb";
}

function databaseConfigured() {
  return mongoEnabled()
    ? Boolean(process.env.MONGODB_URI && process.env.MONGODB_DATABASE)
    : Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function connect() {
  if (!mongoEnabled() || !databaseConfigured()) throw new Error("MongoDB account storage is not configured.");
  if (!connection) {
    connection = (async () => {
      const { MongoClient } = require("mongodb");
      const client = new MongoClient(process.env.MONGODB_URI, {
        maxPoolSize: 10, serverSelectionTimeoutMS: 5000,
      });
      try {
        await client.connect();
        const db = client.db(process.env.MONGODB_DATABASE);
        await Promise.all([
          db.collection("users").createIndex({ email: 1 }, { unique: true }),
          db.collection("users").createIndex({ id: 1 }, { unique: true }),
          db.collection("users").createIndex({ loginName: 1 },
            { unique: true, partialFilterExpression: { loginName: { $type: "string" } } }),
          db.collection("otp_challenges").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
          db.collection("auth_sessions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
          db.collection("auth_rate_limits").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
          db.collection("entitlements").createIndex({ user_id: 1, tier: 1 }, { unique: true }),
          db.collection("payments").createIndex({ id: 1 }, { unique: true }),
          db.collection("payments").createIndex({ provider: 1, provider_reference: 1 },
            { unique: true, partialFilterExpression: { provider_reference: { $type: "string" } } }),
          db.collection("ai_interview_sessions").createIndex({ user_id: 1, created_at: 1 }),
          db.collection("kr7_community_interest").createIndex({ kind: 1, email: 1 }, { unique: true }),
          db.collection("kr7_learner_feedback").createIndex({ request_id: 1 }, { unique: true }),
          db.collection("kr7_contact_requests").createIndex({ request_id: 1 }, { unique: true }),
        ]);
        return { db, client };
      } catch (error) {
        await client.close().catch(() => {});
        const failure = new Error("MongoDB account storage is unavailable.");
        const serverErrors = [...(error.reason?.servers?.values() || [])].map(server => server.error);
        const serverCodes = serverErrors.flatMap(problem => [problem?.code, problem?.cause?.code]);
        const candidates = serverCodes.includes("EACCES")
          ? ["EACCES"] : [...serverCodes, error.code, error.name, "MONGO_CONNECTION_FAILED"];
        failure.code = candidates.map(value => String(value))
          .find(value => /^[A-Za-z0-9_]{1,60}$/.test(value));
        throw failure;
      }
    })().catch(error => { connection = null; throw error; });
  }
  return connection;
}

async function transaction(work) {
  const { db, client } = await connect();
  return client.withSession(session => session.withTransaction(
    () => work(db, session),
    { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } },
  ));
}

module.exports = { mongoEnabled, databaseConfigured, connect, transaction };

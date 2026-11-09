// Postgres for accounts (optional). The database is the CloudNativePG Cluster
// `db` in deploy/postgres.yaml; DATABASE_URL comes from its Secret `db-app`.
// Without DATABASE_URL, enabled() is false and the app runs exactly as before
// (local dev, CI): no accounts, no saved plans.
//
// What's stored: GitHub id, login, name and avatar URL; hashed session ids;
// the planner state a user saved; and, only after opting in, derived social
// signals (tool, topic, language and keyword labels with weights). Never a
// GitHub access token, never code.
//
// Every query is parameterized. pg is traced by the OpenTelemetry
// auto-instrumentation (spans named after the SQL command).
const crypto = require('node:crypto');
const { trace } = require('@opentelemetry/api');

const MIGRATION_LOCK_ID = 727274001; // pg_advisory_lock key for migrations
const SESSION_DAYS = 7;

// Idempotent: safe to run on every start, from every replica at once (under
// the advisory lock).
const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id            bigserial PRIMARY KEY,
  github_id     bigint NOT NULL UNIQUE,
  login         text NOT NULL,
  name          text,
  avatar_url    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  id         text PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);
CREATE TABLE IF NOT EXISTS saved_plans (
  user_id       bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conference_id text NOT NULL,
  state         jsonb NOT NULL,
  saved_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, conference_id)
);
CREATE TABLE IF NOT EXISTS social_profiles (
  user_id       bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conference_id text NOT NULL,
  profile       jsonb NOT NULL,
  opted_in_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, conference_id)
);
`;

// Sessions are looked up by the SHA-256 of the cookie's token, so a database
// leak doesn't hand out live sessions.
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function toUser(row) {
  return row ? { id: String(row.id), githubId: String(row.github_id), login: row.login, name: row.name, avatarUrl: row.avatar_url } : null;
}

// pool: anything with query(text, params) and connect() (a pg.Pool, or a fake in tests).
function createDb(pool) {
  let migrated = null;

  async function migrate() {
    const client = await pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
      try {
        await client.query(MIGRATION_SQL);
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
      }
    } finally {
      client.release();
    }
  }

  // Runs the migration once; after a failure (database not up yet), the next
  // call tries again.
  function ready() {
    if (!migrated) {
      migrated = migrate().catch((err) => {
        migrated = null;
        throw err;
      });
    }
    return migrated;
  }

  async function q(text, params) {
    await ready();
    return pool.query(text, params);
  }

  return {
    enabled: true,
    ready,

    // gh: the GitHub /user response. Returns the user.
    async upsertUser(gh) {
      const { rows } = await q(
        `INSERT INTO users (github_id, login, name, avatar_url)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (github_id) DO UPDATE
           SET login = EXCLUDED.login, name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url, last_login_at = now()
         RETURNING id, github_id, login, name, avatar_url`,
        [gh.id, gh.login, gh.name || null, gh.avatar_url || null],
      );
      return toUser(rows[0]);
    },

    // Returns the raw token for the cookie; only its hash is stored.
    async createSession(userId, days = SESSION_DAYS) {
      const token = crypto.randomBytes(32).toString('base64url');
      await q('DELETE FROM sessions WHERE expires_at < now()');
      await q(
        `INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
        [hashToken(token), userId, days],
      );
      return token;
    },

    async getSessionUser(token) {
      if (!token) return null;
      const { rows } = await q(
        `SELECT u.id, u.github_id, u.login, u.name, u.avatar_url
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.id = $1 AND s.expires_at > now()`,
        [hashToken(token)],
      );
      return toUser(rows[0]);
    },

    async deleteSession(token) {
      if (!token) return;
      await q('DELETE FROM sessions WHERE id = $1', [hashToken(token)]);
    },

    async getPlan(userId, conferenceId) {
      const { rows } = await q(
        'SELECT state, saved_at FROM saved_plans WHERE user_id = $1 AND conference_id = $2',
        [userId, conferenceId],
      );
      return rows[0] ? { state: rows[0].state, savedAt: new Date(rows[0].saved_at).toISOString() } : null;
    },

    async savePlan(userId, conferenceId, state) {
      const { rows } = await q(
        `INSERT INTO saved_plans (user_id, conference_id, state, saved_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (user_id, conference_id) DO UPDATE SET state = EXCLUDED.state, saved_at = now()
         RETURNING saved_at`,
        [userId, conferenceId, JSON.stringify(state)],
      );
      return new Date(rows[0].saved_at).toISOString();
    },

    async getSocialProfile(userId, conferenceId) {
      const { rows } = await q(
        'SELECT profile, opted_in_at FROM social_profiles WHERE user_id = $1 AND conference_id = $2',
        [userId, conferenceId],
      );
      return rows[0] ? { profile: rows[0].profile, optedInAt: new Date(rows[0].opted_in_at).toISOString() } : null;
    },

    async setSocialProfile(userId, conferenceId, profile) {
      await q(
        `INSERT INTO social_profiles (user_id, conference_id, profile, opted_in_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (user_id, conference_id) DO UPDATE SET profile = EXCLUDED.profile`,
        [userId, conferenceId, JSON.stringify(profile)],
      );
    },

    async deleteSocialProfile(userId, conferenceId) {
      await q('DELETE FROM social_profiles WHERE user_id = $1 AND conference_id = $2', [userId, conferenceId]);
    },

    // Real attendees who opted in, for the social matcher. Each entry:
    // { userId, login, displayName, avatarUrl, profile, optedInAt, demo: false }.
    async listOptedInProfiles(conferenceId, { limit = 500 } = {}) {
      const { rows } = await q(
        `SELECT u.id, u.login, u.name, u.avatar_url, p.profile, p.opted_in_at
           FROM social_profiles p JOIN users u ON u.id = p.user_id
          WHERE p.conference_id = $1
          ORDER BY p.opted_in_at DESC
          LIMIT $2`,
        [conferenceId, limit],
      );
      return rows.map((r) => ({
        userId: String(r.id),
        login: r.login,
        displayName: r.name || r.login,
        avatarUrl: r.avatar_url,
        profile: r.profile,
        optedInAt: new Date(r.opted_in_at).toISOString(),
        demo: false,
      }));
    },
  };
}

// ---------- The process-wide database, from DATABASE_URL ----------

let shared = null;

function enabled() {
  return Boolean(process.env.DATABASE_URL);
}

// Returns the shared db, or null when DATABASE_URL is unset.
function getDb() {
  if (!enabled()) return null;
  if (!shared) {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 30000,
      statement_timeout: 5000,
      query_timeout: 6000,
    });
    // An idle client losing its connection (database restart) must not crash
    // the process; the next query reconnects.
    pool.on('error', (err) => {
      console.error(`postgres pool error: ${err && err.code ? err.code : 'unknown'}`);
    });
    shared = createDb(pool);
  }
  return shared;
}

// For the social matcher: [] when accounts are off or the database is down.
async function listOptedInProfiles(conferenceId) {
  const db = getDb();
  if (!db) return [];
  try {
    return await db.listOptedInProfiles(conferenceId);
  } catch (err) {
    const span = trace.getActiveSpan();
    span?.recordException(err);
    span?.setAttribute('accounts.db_error', true);
    return [];
  }
}

module.exports = { createDb, enabled, getDb, listOptedInProfiles, hashToken, MIGRATION_SQL, MIGRATION_LOCK_ID };

import { fileURLToPath as __backupFileURLToPath } from 'node:url';
import { dirname as __backupDirname } from 'node:path';
const __filename = __backupFileURLToPath(import.meta.url);
const __dirname = __backupDirname(__filename);
import { join, resolve } from 'node:path';
import { appendFile, readFile, writeFile, mkdir, open, unlink, readdir, rename, access, rm, stat } from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, execFile, execFileSync } from 'node:child_process';
import require$$0 from 'events';
import { createRequire } from 'node:module';
import require$$0$1 from 'path';
import require$$1 from 'child_process';
import require$$3 from 'stream';
import require$$5 from 'url';

/**
 * Contract constants shared between the API and the module — the validation
 * rules that define valid backup IDs and labels on the wire.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */
const BACKUP_ID_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}__[0-9]{2}-[0-9]{2}-[0-9]{2}__[a-zA-Z0-9_-]+$/;
const LABEL_RE = /^[a-zA-Z0-9_-]+$/;
const LABEL_MAX = 32;

/**
 * Centralised configuration for the standalone backup extension.
 *
 * Unlike the sidecar (which reads `process.env` at import time), the extension
 * runs inside Directus and receives its environment via the endpoint
 * `context.env`. Whether Directus mirrors the parsed `.env` into `process.env`
 * for extensions is not guaranteed, so all environment-derived values are
 * initialised explicitly through {@link initConfig}, which the endpoint handler
 * calls exactly once before any route runs.
 *
 * Environment-independent values (regexes, validation sets, filenames,
 * defaults) remain plain module-level constants.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */
const BACKUP_POLICY_NAME = "Backup Access";
const LIVE_DB = "LIVE_DB";
const MANIFEST_FILE = "backup.json";
const CONFIG_FILE = "backup-config.json";
const LOCKS_DIR_NAME = ".locks";
const UPLOAD_TMP_PREFIX = ".upload-";
const RESTORE_FLAG_NAME = ".pending_restore";
const RESTORE_PROCESSING_NAME = ".restore_processing";
const RESTORE_DONE_NAME = ".restore_done";
const RESTORE_FAILED_NAME = ".restore_failed";
const COLLECTION_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VALID_SCHEDULES = ["off", "1h", "6h", "12h", "daily", "3d", "weekly"];
const VALID_RETENTIONS = ["all", "last-3", "last-5", "last-10", "days-7", "days-30"];
const DEFAULT_SCOPE = { database: true, assets: true, extensions: false, excludedCollections: [] };
const DEFAULT_CONFIG = {
  schedule: "off",
  scheduleMinute: 0,
  scheduleHour: 0,
  retention: "all",
  quotaMB: 0,
  minFreeMB: 100,
  backupScope: { ...DEFAULT_SCOPE }
};
function parseEnabledFlag(v) {
  return v === true || v === "true" || v === "1";
}
function buildCronExpr(schedule, minute, hour) {
  const m = Math.max(0, Math.min(59, Math.floor(minute)));
  const h = Math.max(0, Math.min(23, Math.floor(hour)));
  switch (schedule) {
    case "1h":
      return `${m} * * * *`;
    case "6h":
      return `${m} */6 * * *`;
    case "12h":
      return `${m} */12 * * *`;
    case "daily":
      return `0 ${h} * * *`;
    case "3d":
      return `0 ${h} */3 * *`;
    case "weekly":
      return `0 ${h} * * 0`;
    default:
      return null;
  }
}
const config = {
  backupDir: "/directus/backups",
  uploadsDir: "/directus/uploads",
  extensionsDir: "/directus/extensions",
  dbAdapter: "postgres",
  importEnabled: false,
  exportEnabled: false,
  runnerTimeoutMs: 90 * 6e4,
  adminEmail: "",
  db: { host: "database", port: 5432, user: "", password: "", database: "" },
  cache: { host: "cache", port: 6379, db: 0 },
  hooks: { postRestore: { url: "", secret: "", hint: "" } }
};
function envStr(env, key, def = "") {
  const v = env[key];
  return v === void 0 || v === null ? def : String(v);
}
function normalizeAdapter(name) {
  return name === "pg" ? "postgres" : name;
}
function envInt(env, key, def) {
  const raw = env[key];
  if (raw === void 0 || raw === null || raw === "") return def;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}
function initConfig(env) {
  config.backupDir = envStr(env, "BACKUP_DIR", "/directus/backups");
  config.uploadsDir = envStr(env, "UPLOADS_DIR", "/directus/uploads");
  config.extensionsDir = envStr(env, "EXTENSIONS_DIR", "/directus/extensions");
  config.dbAdapter = normalizeAdapter(envStr(env, "DB_ADAPTER") || envStr(env, "DB_CLIENT") || "postgres");
  config.importEnabled = parseEnabledFlag(env.BACKUP_IMPORT_ENABLED);
  config.exportEnabled = parseEnabledFlag(env.BACKUP_EXPORT_ENABLED);
  const timeoutMin = envInt(env, "RUNNER_TIMEOUT_MIN", 90);
  config.runnerTimeoutMs = timeoutMin * 6e4;
  config.adminEmail = envStr(env, "ADMIN_EMAIL");
  config.db = {
    host: envStr(env, "DB_HOST", "database"),
    port: envInt(env, "DB_PORT", 5432),
    user: envStr(env, "DB_USER"),
    password: envStr(env, "DB_PASSWORD"),
    database: envStr(env, "DB_DATABASE")
  };
  const cacheHost = env.CACHE_HOST === void 0 ? "cache" : String(env.CACHE_HOST);
  config.cache = {
    host: cacheHost,
    port: envInt(env, "CACHE_PORT", 6379),
    db: envInt(env, "CACHE_DB", 0)
  };
  config.hooks = {
    postRestore: {
      url: envStr(env, "HOOK_POST_RESTORE_URL"),
      secret: envStr(env, "HOOK_POST_RESTORE_SECRET"),
      hint: envStr(env, "HOOK_POST_RESTORE_HINT")
    }
  };
}
function restoreFlagPath() {
  return join(config.backupDir, RESTORE_FLAG_NAME);
}
function restoreMarkerPath(name) {
  return join(config.backupDir, name);
}

/**
 * Runtime context singleton.
 *
 * The Directus endpoint hands the extension a context object (services, schema
 * accessor, database, logger). Module-level helpers such as {@link notify} need
 * access to it without threading it through every call, so the handler stores it
 * once via {@link setRuntime} at startup — mirroring the sidecar's `ctx`
 * singleton pattern, but populated from the endpoint context instead of Docker.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */
let runtime = null;
function setRuntime(r) {
  runtime = r;
}
function getRuntime() {
  if (!runtime) throw new Error("Runtime not initialised \u2014 setRuntime() must run at endpoint startup");
  return runtime;
}

/**
 * Append-only activity log stored as JSON-Lines under `BACKUP_DIR`.
 * Each line is a single JSON object with a timestamp and event data.
 *
 * The log path is derived from {@link config} at call time, so it always
 * reflects the initialised backup directory.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */
const LOG_FILE_NAME = "backup-activity.jsonl";
const MAX_ENTRIES = 100;
const TRIM_THRESHOLD = 200;
function logFile() {
  return join(config.backupDir, LOG_FILE_NAME);
}
async function appendActivity(entry) {
  const full = { timestamp: (/* @__PURE__ */ new Date()).toISOString(), ...entry };
  const file = logFile();
  await appendFile(file, `${JSON.stringify(full)}
`, "utf8");
  try {
    const raw = await readFile(file, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    if (lines.length > TRIM_THRESHOLD) {
      await writeFile(file, `${lines.slice(-MAX_ENTRIES).join("\n")}
`, "utf8");
    }
  } catch {
  }
}
async function readActivity(limit = MAX_ENTRIES) {
  try {
    const raw = await readFile(logFile(), "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const entries = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
      }
    }
    return entries.slice(-limit).reverse();
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Per-resource lock management. Two lock domains: the global `LIVE_DB` sentinel
 * (backup, restore) and per-backup-ID locks (restore source, download, delete).
 *
 * Stateless — paths are derived from {@link config} at call time.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */
function locksPath() {
  return join(config.backupDir, LOCKS_DIR_NAME);
}
function isValidLockResource(resource) {
  return resource === LIVE_DB || BACKUP_ID_RE.test(String(resource));
}
function lockFilePath(resource) {
  return join(locksPath(), `${resource}.lock`);
}
async function readAllLocks() {
  let names;
  try {
    names = await readdir(locksPath());
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const locks = [];
  for (const name of names) {
    if (!name.endsWith(".lock")) continue;
    try {
      locks.push(JSON.parse(await readFile(join(locksPath(), name), "utf8")));
    } catch {
      const resource = name.slice(0, -".lock".length);
      if (isValidLockResource(resource)) locks.push({ resource, corrupt: true });
    }
  }
  return locks;
}
async function acquireLock(resource, data) {
  if (!isValidLockResource(resource)) throw new Error(`Invalid lock resource: ${resource}`);
  await mkdir(locksPath(), { recursive: true });
  let fd;
  try {
    fd = await open(lockFilePath(resource), "wx");
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e;
  }
  try {
    await fd.writeFile(`${JSON.stringify({ resource, ...data }, null, 2)}
`);
  } finally {
    await fd.close();
  }
  return true;
}
async function releaseLock(resource) {
  if (!isValidLockResource(resource)) return;
  try {
    await unlink(lockFilePath(resource));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}

/**
 * Backup manifest (`backup.json`) read/write helpers.
 *
 * Stateless — paths are derived from {@link config} at call time.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */
async function writeManifest(dir, data) {
  await mkdir(dir, { recursive: true });
  const target = join(dir, MANIFEST_FILE);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}
`);
  await rename(tmp, target);
}
async function readManifest(dir) {
  try {
    return JSON.parse(await readFile(join(dir, MANIFEST_FILE), "utf8"));
  } catch {
    return null;
  }
}
async function readAllManifests() {
  try {
    const entries = await readdir(config.backupDir, { withFileTypes: true });
    const manifests = [];
    for (const e of entries) {
      if (!e.isDirectory() || !BACKUP_ID_RE.test(e.name)) continue;
      const m = await readManifest(join(config.backupDir, e.name));
      if (m) manifests.push(m);
    }
    return manifests;
  } catch {
    return [];
  }
}

/**
 * Parsers for the verify artefacts written by the runner: backup checksums and
 * row counts, post-restore count verification, and per-component restore result.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */
async function parseVerifyData(dir) {
  const checksumRaw = await readFile(join(dir, "checksums.sha256"), "utf8");
  const countsRaw = await readFile(join(dir, "db-counts.txt"), "utf8");
  const checksums = {};
  for (const line of checksumRaw.trim().split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) checksums[parts[parts.length - 1]] = parts[0];
  }
  const dbCounts = {};
  let dumpTables = null;
  for (const line of countsRaw.trim().split("\n")) {
    if (!line.trim()) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx < 0) continue;
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();
    if (key === "__dump_tables") {
      dumpTables = parseInt(value, 10);
    } else {
      dbCounts[key] = parseInt(value, 10);
    }
  }
  let collections;
  try {
    const tablesRaw = await readFile(join(dir, "db-tables.txt"), "utf8");
    collections = tablesRaw.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
  }
  return { checksums, ...dumpTables === null ? {} : { dumpTables }, dbCounts, ...collections ? { collections } : {} };
}
async function parseRestoreVerify(dir) {
  const raw = await readFile(join(dir, "restore-verify.txt"), "utf8");
  const result = {};
  for (const line of raw.trim().split("\n")) {
    const eqIdx = line.indexOf("=");
    if (eqIdx < 0) continue;
    result[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim();
  }
  const mismatches = parseInt(result.mismatches || "0", 10);
  const details = {};
  for (const [k, v] of Object.entries(result)) {
    if (k.startsWith("mismatch.")) details[k.slice(9)] = v;
  }
  return {
    status: mismatches === 0 ? "ok" : "warn",
    mismatches,
    ...mismatches > 0 ? { details } : {}
  };
}
async function parseRestoreResult(dir) {
  let raw;
  try {
    raw = await readFile(join(dir, "restore-result.txt"), "utf8");
  } catch {
    return null;
  }
  const keyMap = { db: "database", assets: "assets", extensions: "extensions" };
  const result = {};
  for (const line of raw.trim().split("\n")) {
    const eqIdx = line.indexOf("=");
    if (eqIdx < 0) continue;
    const key = keyMap[line.slice(0, eqIdx).trim()];
    if (key) result[key] = line.slice(eqIdx + 1).trim();
  }
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Directus API helpers: version detection and in-app notifications.
 *
 * The sidecar talked to Directus over HTTP with a static token. Running inside
 * Directus, the extension uses the in-process services and database instead, so
 * no token and no network round-trip are needed.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */
async function fetchDirectusVersion() {
  try {
    const { services, getSchema, database } = getRuntime();
    const { ServerService } = services;
    if (!ServerService) return null;
    const schema = await getSchema();
    const server = new ServerService({
      accountability: { admin: true, role: null, user: null },
      schema,
      knex: database
    });
    const info = await server.serverInfo();
    return info?.version ?? info?.directus?.version ?? null;
  } catch (e) {
    getRuntime().logger?.warn?.(`Could not fetch Directus version: ${e.message}`);
    return null;
  }
}
async function resolveRecipients() {
  const { database } = getRuntime();
  if (config.adminEmail) {
    const user = await database("directus_users").where("email", config.adminEmail).select("id").first();
    if (user?.id) return [user.id];
  }
  const admins = await database("directus_users").join("directus_roles", "directus_users.role", "directus_roles.id").where("directus_roles.name", "Administrator").limit(50).pluck("directus_users.id");
  return Array.isArray(admins) ? admins : [];
}
async function notifyAdmins(subject, message) {
  const { services, getSchema, database, logger } = getRuntime();
  try {
    const recipients = await resolveRecipients();
    if (!recipients.length) {
      logger?.warn?.('Notification skipped: no recipients (set ADMIN_EMAIL or ensure an "Administrator" role exists)');
      return;
    }
    const { NotificationsService } = services;
    if (!NotificationsService) {
      logger?.warn?.("Notification skipped: NotificationsService unavailable");
      return;
    }
    const schema = await getSchema();
    const notifications = new NotificationsService({
      accountability: { admin: true, role: null, user: null },
      schema,
      knex: database
    });
    await notifications.createMany(recipients.map((recipient) => ({ recipient, subject, message })));
    logger?.info?.(`Notification sent to ${recipients.length} recipient(s): ${subject}`);
  } catch (e) {
    logger?.warn?.(`Failed to send notification: ${e.message}`);
  }
}

/**
 * Runner process plumbing shared by backups and restores: script resolution,
 * environment/scope construction, the detached child-process spawner with its
 * timeout watchdog, and the cancellation registry.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */
let cachedScriptDir = null;
async function resolveScriptsDir() {
  if (cachedScriptDir) return cachedScriptDir;
  const roots = [join(config.extensionsDir, ".registry"), config.extensionsDir];
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = join(root, entry, "scripts");
      try {
        await access(join(candidate, "backup.sh"));
        cachedScriptDir = candidate;
        return candidate;
      } catch {
      }
    }
  }
  throw new Error(`backup.sh not found under ${config.extensionsDir} (searched .registry/*/scripts and */scripts)`);
}
const activeKillFns = /* @__PURE__ */ new Map();
const cancelledIds = /* @__PURE__ */ new Set();
function cancelBackup(backupId) {
  const kill = activeKillFns.get(backupId);
  if (!kill) return false;
  cancelledIds.add(backupId);
  kill();
  return true;
}
function buildRunnerEnv(backupId, backupPath, scopeEnv) {
  const env = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    BACKUP_ID: backupId,
    BACKUP_PATH: backupPath,
    DB_ADAPTER: config.dbAdapter,
    DB_HOST: config.db.host,
    DB_PORT: String(config.db.port),
    DB_USER: config.db.user,
    DB_PASSWORD: config.db.password,
    DB_DATABASE: config.db.database,
    UPLOADS_DIR: config.uploadsDir,
    EXTENSIONS_DIR: config.extensionsDir
  };
  for (const entry of scopeEnv) {
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}
function buildScopeEnv(mode, scope) {
  const prefix = mode === "backup" ? "BACKUP" : "RESTORE";
  const envs = [
    `${prefix}_INCLUDE_DB=${scope.database ? "1" : "0"}`,
    `${prefix}_INCLUDE_ASSETS=${scope.assets ? "1" : "0"}`,
    `${prefix}_INCLUDE_EXTENSIONS=${scope.extensions ? "1" : "0"}`
  ];
  if (scope.excludedCollections && scope.excludedCollections.length > 0) {
    envs.push(`${prefix}_EXCLUDE_TABLES=${scope.excludedCollections.join(",")}`);
    envs.push(`${prefix}_INCLUDE_TABLES=`);
  } else {
    envs.push(`${prefix}_INCLUDE_TABLES=${(scope.includeCollections || []).join(",")}`);
    envs.push(`${prefix}_EXCLUDE_TABLES=`);
  }
  return envs;
}
function spawnRunner(env, logPath, { timeoutMs = config.runnerTimeoutMs, command, args = [] }) {
  return new Promise((resolve, reject) => {
    const logStream = createWriteStream(logPath, { flags: "a" });
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true
    });
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);
    let timedOut = false;
    let killTimer = null;
    let escalateTimer = null;
    const killGroup = (signal) => {
      if (child.pid === void 0) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
        }
      }
    };
    const runBackupId = env.BACKUP_ID;
    if (runBackupId) activeKillFns.set(runBackupId, () => killGroup("SIGTERM"));
    if (timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        logStream.write(`
[runner] Aborted: exceeded timeout of ${Math.round(timeoutMs / 1e3)}s \u2014 terminating process group
`);
        killGroup("SIGTERM");
        escalateTimer = setTimeout(() => killGroup("SIGKILL"), 1e4);
      }, timeoutMs);
    }
    child.on("close", (code) => {
      if (runBackupId) activeKillFns.delete(runBackupId);
      if (killTimer) clearTimeout(killTimer);
      if (escalateTimer) clearTimeout(escalateTimer);
      logStream.end();
      resolve({ exitCode: timedOut ? code ?? 124 : code ?? 1, timedOut });
    });
    child.on("error", (err) => {
      if (killTimer) clearTimeout(killTimer);
      if (escalateTimer) clearTimeout(escalateTimer);
      logStream.end();
      reject(err);
    });
  });
}

/**
 * Installation sanity checks for the standalone backup extension.
 *
 * Detects incomplete deployments (Marketplace-only install, missing Dockerfile
 * steps, absent PostgreSQL client binaries, etc.) and surfaces actionable
 * remediation hints to the API and UI.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */
const SUPPORTED_DB_ADAPTERS = ["postgres"];
const POSTGRES_BINARIES = ["pg_dump", "pg_restore", "psql"];
const REQUIRED_BINARIES = ["tar", "sha256sum", "df"];
const OPTIONAL_BINARIES = ["nc"];
let cached = null;
let cachedAt = 0;
const CACHE_MS = 3e4;
function commandExists(cmd) {
  return new Promise((resolve) => {
    const proc = spawn("sh", ["-c", `command -v ${cmd} >/dev/null 2>&1`], { stdio: "ignore" });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}
function issue(code, severity, message, fix, params) {
  return { code, severity, message, fix, params };
}
async function checkScripts(issues) {
  try {
    const dir = await resolveScriptsDir();
    await access(join(dir, "restore.sh"));
    if (!SUPPORTED_DB_ADAPTERS.includes(config.dbAdapter)) return dir;
    const adapter = join(dir, "adapters", `${config.dbAdapter}.sh`);
    try {
      await access(adapter);
    } catch {
      issues.push(issue(
        "ADAPTER_MISSING",
        "error",
        `Database adapter script not found: adapters/${config.dbAdapter}.sh`,
        "Reinstall the extension package or verify DB_ADAPTER matches an adapter under scripts/adapters/.",
        { adapter: config.dbAdapter }
      ));
    }
    return dir;
  } catch (e) {
    issues.push(issue(
      "SCRIPTS_MISSING",
      "error",
      e.message || "Runner scripts not found",
      "Install the full extension package (including scripts/) or verify EXTENSIONS_PATH points at the built bundle."
    ));
    return null;
  }
}
function checkSupportedAdapter(issues) {
  if (SUPPORTED_DB_ADAPTERS.includes(config.dbAdapter)) return true;
  issues.push(issue(
    "UNSUPPORTED_ADAPTER",
    "error",
    `Database adapter "${config.dbAdapter}" is not supported in this release`,
    `Use DB_ADAPTER=postgres. Supported adapters: ${SUPPORTED_DB_ADAPTERS.join(", ")}.`,
    { adapter: config.dbAdapter, supported: SUPPORTED_DB_ADAPTERS.join(", ") }
  ));
  return false;
}
async function checkBackupDirWritable(issues) {
  const probe = join(config.backupDir, `.sanity-${process.pid}`);
  try {
    await writeFile(probe, "ok");
    await rm(probe);
  } catch (e) {
    issues.push(issue(
      "BACKUP_DIR_NOT_WRITABLE",
      "error",
      `Backup directory is not writable: ${config.backupDir}`,
      "Mount a backup volume at BACKUP_DIR and ensure it is owned by the Directus user (see installation.md).",
      { path: config.backupDir }
    ));
  }
}
async function checkRestoreBootstrap(issues) {
  try {
    const raw = await readFile("/entrypoint.sh", "utf8");
    if (!raw.includes("restore.sh")) {
      issues.push(issue(
        "ENTRYPOINT_NOT_CONFIGURED",
        "error",
        "Container entrypoint does not run restore.sh before Directus starts",
        "Override ENTRYPOINT with the extension entrypoint stub (see examples/entrypoint.sh and installation.md)."
      ));
    }
  } catch {
    issues.push(issue(
      "ENTRYPOINT_NOT_CONFIGURED",
      "error",
      "Custom container entrypoint (/entrypoint.sh) not found",
      "Extend the Directus image with the restore entrypoint stub from examples/entrypoint.sh."
    ));
  }
  try {
    const cmdline = (await readFile("/proc/1/cmdline", "utf8")).replace(/\0/g, " ");
    const isShell = /\b(sh|bash|ash|dash)\b/.test(cmdline) && !/\bpm2\b/i.test(cmdline) && !/\bnode\b/i.test(cmdline);
    if (isShell) {
      issues.push(issue(
        "RESTART_HANDLER_MISSING",
        "error",
        "PID 1 is a shell \u2014 SIGTERM will not reach Directus and container restores will not work",
        "Use `exec pm2-runtime start ecosystem.config.cjs` or `exec node cli.js start` so a signal-forwarding process is PID 1, and set restart: unless-stopped in Compose."
      ));
    } else if (!/\bpm2\b/i.test(cmdline) && !/\bnode\b/i.test(cmdline)) {
      issues.push(issue(
        "RESTART_HANDLER_MISSING",
        "error",
        "PID 1 does not look like pm2-runtime or node \u2014 container restart restores may not work",
        "Use the stock Directus start command so PID 1 is pm2-runtime, and set restart: unless-stopped in Compose."
      ));
    }
  } catch {
    issues.push(issue(
      "RESTART_HANDLER_UNKNOWN",
      "warning",
      "Could not verify PID 1 (non-Linux host) \u2014 restore restart mechanism not checked",
      "On production Linux containers, PID 1 must be pm2-runtime and restart: unless-stopped must be set."
    ));
  }
  try {
    await access(restoreMarkerPath(RESTORE_FLAG_NAME));
    issues.push(issue(
      "PENDING_RESTORE_STUCK",
      "error",
      "A restore was armed but never consumed (.pending_restore is still present)",
      "Restart the container so the entrypoint runs restore.sh, or remove the stale flag/locks after verifying the deployment."
    ));
  } catch {
  }
}
async function runSanityCheck() {
  const issues = [];
  const adapterSupported = checkSupportedAdapter(issues);
  await checkScripts(issues);
  for (const bin of REQUIRED_BINARIES) {
    if (!await commandExists(bin)) {
      issues.push(issue(
        "BINARY_MISSING",
        "error",
        `Required command not found: ${bin}`,
        "Install the missing utility in the Directus container image.",
        { binary: bin }
      ));
    }
  }
  if (adapterSupported) {
    for (const bin of POSTGRES_BINARIES) {
      if (!await commandExists(bin)) {
        issues.push(issue(
          "BINARY_MISSING",
          "error",
          `Required command not found: ${bin}`,
          "Install postgresql-client in the Directus image (apk add postgresql16-client \u2014 see installation.md).",
          { binary: bin }
        ));
      }
    }
  }
  for (const bin of OPTIONAL_BINARIES) {
    if (!await commandExists(bin)) {
      issues.push(issue(
        "BINARY_MISSING",
        "warning",
        `Optional command not found: ${bin}`,
        "Install netcat-openbsd (or busybox nc) so restore.sh can flush Redis after a restore.",
        { binary: bin }
      ));
    }
  }
  if (config.runnerTimeoutMs > 0 && !await commandExists("setsid")) {
    issues.push(issue(
      "SETSID_MISSING",
      "error",
      "setsid is required for boot-time restore timeout enforcement",
      "Install util-linux (setsid) or set RUNNER_TIMEOUT_MIN=0 to explicitly disable restore timeout enforcement."
    ));
  }
  await checkBackupDirWritable(issues);
  await checkRestoreBootstrap(issues);
  const errors = issues.filter((i) => i.severity === "error");
  const backupBlockers = /* @__PURE__ */ new Set([
    "SCRIPTS_MISSING",
    "ADAPTER_MISSING",
    "UNSUPPORTED_ADAPTER",
    "BINARY_MISSING",
    "BACKUP_DIR_NOT_WRITABLE"
  ]);
  const restoreBlockers = /* @__PURE__ */ new Set([
    ...backupBlockers,
    "ENTRYPOINT_NOT_CONFIGURED",
    "RESTART_HANDLER_MISSING",
    "PENDING_RESTORE_STUCK",
    "SETSID_MISSING"
  ]);
  const operational = !errors.some((i) => backupBlockers.has(i.code));
  const restoreReady = !errors.some((i) => restoreBlockers.has(i.code));
  return {
    ok: errors.length === 0,
    operational,
    restoreReady,
    issues,
    checkedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
async function getSanityReport(force = false) {
  if (!force && cached && Date.now() - cachedAt < CACHE_MS) return cached;
  cached = await runSanityCheck();
  cachedAt = Date.now();
  return cached;
}
function installationError(report) {
  const err = report.issues.find((i) => i.severity === "error");
  return err?.message || "Backup extension installation is incomplete";
}

/**
 * Restore arming (Directus still up) and the container-restart handoff.
 *
 * Restores cannot run while Directus holds database connections, so the
 * destructive work is moved out of this process entirely (no Docker socket):
 * 1. {@link requestRestore} Validates the backup while Directus is still up,
 * writes a `KEY=VALUE` flag file, and acquires the locks.
 * 2. {@link scheduleContainerRestart} Sends `SIGTERM` to PID 1 (pm2-runtime),
 * which — together with the container's `restart: unless-stopped` policy —
 * restarts the container. `restore.sh` then runs the actual restore on the
 * fresh, idle boot, before Directus starts, and leaves a result marker.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */
function resolveRestoreScope(manifest, requestScope) {
  const scope = manifest.scope || {};
  const base = requestScope || {
    database: scope.database !== false,
    assets: scope.assets !== false,
    extensions: scope.extensions !== false,
    includeCollections: []
  };
  const backupIncluded = Array.isArray(scope.includedCollections) ? scope.includedCollections : [];
  const requestIncluded = base.includeCollections || [];
  let effectiveInclude;
  if (backupIncluded.length === 0 && requestIncluded.length === 0) {
    effectiveInclude = [];
  } else if (backupIncluded.length === 0) {
    effectiveInclude = requestIncluded;
  } else if (requestIncluded.length === 0) {
    effectiveInclude = backupIncluded;
  } else {
    const backupSet = new Set(backupIncluded);
    effectiveInclude = requestIncluded.filter((c) => backupSet.has(c));
  }
  const restoreScope = {
    database: Boolean(base.database) && scope.database !== false,
    assets: Boolean(base.assets) && scope.assets !== false,
    extensions: Boolean(base.extensions) && scope.extensions !== false,
    includeCollections: effectiveInclude
  };
  return { restoreScope, scopeEnv: buildScopeEnv("restore", restoreScope) };
}
function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
function pgRestoreListExit(dumpPath) {
  return new Promise((resolve) => {
    execFile("pg_restore", ["--list", dumpPath], (err) => {
      const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
      resolve(code);
    });
  });
}
async function validateRestore(manifest, backupPath, restoreScope) {
  if (manifest.status !== "success") {
    return { ok: false, error: `Backup status is "${String(manifest.status)}", not "success" \u2014 refusing to restore` };
  }
  try {
    const checksumRaw = await readFile(join(backupPath, "checksums.sha256"), "utf8");
    for (const line of checksumRaw.trim().split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const expected = parts[0];
      const file = parts[parts.length - 1];
      let actual;
      try {
        actual = await sha256File(join(backupPath, file));
      } catch {
        return { ok: false, error: `Backup file missing or unreadable: ${file}` };
      }
      if (actual !== expected) {
        return { ok: false, error: `Checksum mismatch for ${file} \u2014 backup is corrupt` };
      }
    }
  } catch {
    getRuntime().logger?.warn?.("Restore validation: no checksums.sha256 \u2014 skipping checksum verify (legacy backup)");
  }
  if (restoreScope.database) {
    const dumpPath = join(backupPath, "database.dump");
    try {
      await access(dumpPath);
    } catch {
      return { ok: false, error: "Database restore requested but database.dump is missing" };
    }
    const listExit = await pgRestoreListExit(dumpPath);
    if (listExit !== 0) {
      return { ok: false, error: `Dump is not readable by pg_restore (exit ${listExit}) \u2014 refusing to restore` };
    }
    try {
      await getRuntime().database.raw("select 1");
    } catch (e) {
      return { ok: false, error: `Database not reachable: ${e.message}` };
    }
  }
  return { ok: true };
}
function shQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
function toFlagContent(vars) {
  return `${Object.entries(vars).map(([k, v]) => `${k}=${shQuote(v)}`).join("\n")}
`;
}
async function writeFlagAtomically(content) {
  const target = restoreFlagPath();
  const tmp = `${target}.tmp`;
  const fd = await open(tmp, "w");
  try {
    await fd.writeFile(content, "utf8");
    await fd.sync();
  } finally {
    await fd.close();
  }
  await rename(tmp, target);
}
async function requestRestore(backupId, manifest, backupPath, requestScope) {
  const { restoreScope, scopeEnv } = resolveRestoreScope(manifest, requestScope);
  if (restoreScope.database && restoreScope.includeCollections.length > 0) {
    const scopeData = manifest.scope || {};
    const dumpCollections = Array.isArray(scopeData.collections) ? scopeData.collections : null;
    if (dumpCollections !== null) {
      const dumpSet = new Set(dumpCollections);
      const unknown = restoreScope.includeCollections.filter((c) => !dumpSet.has(c));
      if (unknown.length > 0) {
        const error = `Collections not present in backup dump: ${unknown.join(", ")}`;
        appendActivity({ action: "restore_failed", backupId, detail: error }).catch(() => {
        });
        return { ok: false, status: 422, error };
      }
    }
  }
  const sanity = await getSanityReport();
  if (!sanity.restoreReady) {
    return {
      ok: false,
      status: 503,
      error: installationError(sanity),
      code: "INSTALL_INCOMPLETE"
    };
  }
  const validation = await validateRestore(manifest, backupPath, restoreScope);
  if (!validation.ok) {
    appendActivity({ action: "restore_failed", backupId, detail: validation.error }).catch(() => {
    });
    return { ok: false, status: 422, error: validation.error };
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const liveLocked = await acquireLock(LIVE_DB, { backupId, startedAt: now, operation: "restore" });
  if (!liveLocked) {
    return { ok: false, status: 409, error: "Another backup or restore is already running" };
  }
  const idLocked = await acquireLock(backupId, { backupId, startedAt: now, operation: "restore" });
  if (!idLocked) {
    await releaseLock(LIVE_DB);
    return { ok: false, status: 409, error: "This backup is busy (download or delete in progress)" };
  }
  const flagVars = {
    BACKUP_ID: backupId,
    BACKUP_PATH: backupPath,
    DB_ADAPTER: config.dbAdapter,
    UPLOADS_DIR: config.uploadsDir,
    EXTENSIONS_DIR: config.extensionsDir
  };
  for (const entry of scopeEnv) {
    const eq = entry.indexOf("=");
    if (eq > 0) flagVars[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  try {
    await writeFlagAtomically(toFlagContent(flagVars));
  } catch (e) {
    await releaseLock(backupId);
    await releaseLock(LIVE_DB);
    const error = `Could not arm restore: ${e.message}`;
    appendActivity({ action: "restore_failed", backupId, detail: error }).catch(() => {
    });
    return { ok: false, status: 503, error };
  }
  return { ok: true, status: 202, backupId };
}
function scheduleContainerRestart(backupId, delayMs = 1e3) {
  getRuntime().logger?.info?.("Restore armed \u2014 scheduling container restart (SIGTERM to PID 1)");
  setTimeout(async () => {
    try {
      process.kill(1, "SIGTERM");
    } catch (e) {
      const msg = `Could not signal PID 1 for restart: ${e.message}`;
      getRuntime().logger?.error?.(msg);
      try {
        await unlink(restoreFlagPath());
      } catch {
      }
      await releaseLock(backupId).catch(() => {
      });
      await releaseLock(LIVE_DB).catch(() => {
      });
      appendActivity({ action: "restore_failed", backupId, detail: msg }).catch(() => {
      });
    }
  }, delayMs);
}
async function waitForDirectusReady(logger) {
  const port = process.env.PORT ?? "8055";
  const healthUrl = `http://localhost:${port}/server/health`;
  const deadlineMs = 3 * 60 * 1e3;
  const intervalMs = 3e3;
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5e3) });
      if (res.ok) {
        logger?.info?.("Directus ready \u2014 firing post-restore hook");
        return;
      }
    } catch {
    }
    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }
  logger?.warn?.("Directus health check timed out after 3 min \u2014 firing post-restore hook anyway");
}
async function triggerPostRestoreHook(backupId) {
  const { url, secret, hint } = config.hooks.postRestore;
  if (!url) return;
  await waitForDirectusReady(getRuntime().logger);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1e3);
    const response = await fetch(url, {
      method: "POST",
      headers: { ...secret && { "X-Webhook-Secret": secret } },
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`Hook returned ${response.status}: ${errorText}`);
    }
    getRuntime().logger?.info?.("Post-restore hook completed successfully");
  } catch (error) {
    const err = error;
    const errorMsg = err.name === "AbortError" ? "Post-restore hook timed out after 5 minutes" : err.message;
    getRuntime().logger?.error?.(`Post-restore hook failed: ${errorMsg}`);
    const hintText = hint ? `

Recovery: ${hint}` : "";
    notifyAdmins(
      "Restore completed but post-restore hook failed",
      `Backup ${backupId} was restored successfully, but the post-restore hook failed.

Error: ${errorMsg}${hintText}`
    ).catch(() => {
    });
  }
}

/**
 * Boot-time reconciliation of a completed (or abandoned) restore. Reads the
 * handshake marker left by `restore.sh`, updates the manifest with the restore
 * outcome, appends activity, fires the post-restore hook on success, releases
 * the locks, and removes the marker.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */
function unquoteFlagValue(value) {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).split("'\\''").join("'");
  }
  return value;
}
function parseFlagFile(raw) {
  const out = {};
  for (const line of raw.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = unquoteFlagValue(line.slice(eq + 1).trim());
  }
  return out;
}
async function finalizePendingRestore() {
  const candidates = [
    { name: RESTORE_DONE_NAME, outcome: "done" },
    { name: RESTORE_FAILED_NAME, outcome: "failed" },
    { name: RESTORE_PROCESSING_NAME, outcome: "crashed" },
    { name: RESTORE_FLAG_NAME, outcome: "unfired" }
  ];
  for (const { name, outcome } of candidates) {
    const path = restoreMarkerPath(name);
    let raw;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const vars = parseFlagFile(raw);
    const backupId = vars.BACKUP_ID;
    if (!backupId || !BACKUP_ID_RE.test(backupId)) {
      await rm(path, { force: true });
      continue;
    }
    const backupPath = join(config.backupDir, backupId);
    try {
      await reconcileRestoreOutcome(backupId, backupPath, outcome);
    } catch (e) {
      getRuntime().logger?.error?.(`Restore reconcile failed for ${backupId}: ${e.message}`);
    }
    await releaseLock(backupId);
    await releaseLock(LIVE_DB);
    await rm(path, { force: true });
  }
}
async function reconcileRestoreOutcome(backupId, backupPath, outcome) {
  const manifest = await readManifest(backupPath);
  if (!manifest) {
    getRuntime().logger?.warn?.(`Restore reconcile: manifest missing for ${backupId}`);
    return;
  }
  manifest.restoredAt = (/* @__PURE__ */ new Date()).toISOString();
  if (outcome === "done") {
    const restoreResult = await parseRestoreResult(backupPath);
    if (restoreResult) manifest.restore = restoreResult;
    manifest.restoreStatus = "success";
    delete manifest.restoreError;
    try {
      manifest.restoreVerify = await parseRestoreVerify(backupPath);
    } catch {
    }
  } else {
    manifest.restoreStatus = "failed";
    manifest.restoreError = await deriveRestoreError(backupPath, outcome);
  }
  await writeManifest(backupPath, manifest);
  appendActivity({
    action: manifest.restoreStatus === "success" ? "restore_success" : "restore_failed",
    backupId,
    detail: manifest.restoreStatus === "success" ? void 0 : String(manifest.restoreError)
  }).catch(() => {
  });
  if (manifest.restoreStatus === "success") {
    await triggerPostRestoreHook(backupId);
  }
}
async function deriveRestoreError(backupPath, outcome) {
  if (outcome === "unfired") {
    return 'Restore did not run: the container did not restart into the restore entrypoint. Verify the Dockerfile ENTRYPOINT override and the "restart: unless-stopped" policy. The database was not modified.';
  }
  if (outcome === "crashed") {
    return "The restore was interrupted before it finished \u2014 outcome unknown; the database may be partially restored. Review runner.log and re-run the restore.";
  }
  try {
    const msg = (await readFile(join(backupPath, "restore-error.txt"), "utf8")).trim();
    if (msg) return msg;
  } catch {
  }
  try {
    const log = (await readFile(join(backupPath, "runner.log"), "utf8")).trim();
    const tail = log.split("\n").slice(-20).join("\n");
    if (tail) return tail;
  } catch {
  }
  return "Restore failed (no further detail available)";
}

/**
 * Startup crash recovery: clean up stale locks left by an interrupted backup or
 * restore, then mark any manifest still stuck at `running` as failed.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */
async function recoverStaleLock(lock) {
  const resource = String(lock.resource);
  const { operation } = lock;
  if (resource === LIVE_DB) {
    const backupId = lock.backupId ? String(lock.backupId) : null;
    if (!backupId || !BACKUP_ID_RE.test(backupId)) return;
    const dir2 = join(config.backupDir, backupId);
    const m = await readManifest(dir2);
    if (!m) return;
    if (operation === "restore") {
      m.restoredAt = m.restoredAt || (/* @__PURE__ */ new Date()).toISOString();
      m.restoreStatus = "failed";
      m.restoreError = "Directus restarted during restore \u2014 outcome unknown; the database may be partially restored. Re-run the restore.";
      await writeManifest(dir2, m);
      appendActivity({ action: "restore_failed", backupId, detail: String(m.restoreError) }).catch(() => {
      });
    } else if (m.status === "running") {
      m.status = "failed";
      m.error = "Stale lock recovered on startup";
      m.finishedAt = (/* @__PURE__ */ new Date()).toISOString();
      await writeManifest(dir2, m);
    }
    return;
  }
  if (!BACKUP_ID_RE.test(resource)) return;
  const dir = join(config.backupDir, resource);
  if (operation === "delete") {
    try {
      await rm(dir, { recursive: true, force: true });
      getRuntime().logger?.info?.(`Completed interrupted delete: ${resource}`);
    } catch (e) {
      getRuntime().logger?.warn?.(`Could not complete interrupted delete for ${resource}: ${e.message}`);
    }
    appendActivity({ action: "delete", backupId: resource, detail: "Completed after restart during delete" }).catch(() => {
    });
  } else if (operation === "import") {
    try {
      await rm(dir, { recursive: true, force: true });
      getRuntime().logger?.info?.(`Cleaned up partial import: ${resource}`);
    } catch (e) {
      getRuntime().logger?.warn?.(`Could not clean up partial import ${resource}: ${e.message}`);
    }
    appendActivity({ action: "delete", backupId: resource, detail: "Cleaned up after restart during import" }).catch(() => {
    });
  }
}
async function recoverStaleLocks() {
  const locks = await readAllLocks();
  if (locks.length === 0) return;
  getRuntime().logger?.info?.(`Found ${locks.length} stale lock(s) on startup \u2014 cleaning up`);
  for (const lock of locks) {
    try {
      await recoverStaleLock(lock);
    } catch (e) {
      getRuntime().logger?.warn?.(`Lock recovery failed for ${String(lock.resource)}: ${e.message}`);
    }
    await releaseLock(String(lock.resource));
  }
}
async function cleanStaleTmpFiles() {
  let entries;
  try {
    entries = await readdir(config.backupDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(UPLOAD_TMP_PREFIX)) continue;
    try {
      await rm(join(config.backupDir, name), { force: true });
      getRuntime().logger?.info?.(`Cleaned up stale upload temp file: ${name}`);
    } catch (e) {
      getRuntime().logger?.warn?.(`Could not remove stale upload temp file ${name}: ${e.message}`);
    }
  }
}
async function reconcileRunningManifests() {
  const manifests = await readAllManifests();
  for (const m of manifests) {
    if (m.status !== "running") continue;
    const id = String(m.id);
    if (!BACKUP_ID_RE.test(id)) continue;
    m.status = "failed";
    m.error = m.error || "Backup left running after restart \u2014 outcome unknown";
    m.finishedAt = m.finishedAt || (/* @__PURE__ */ new Date()).toISOString();
    try {
      await writeManifest(join(config.backupDir, id), m);
      getRuntime().logger?.info?.(`Reconciled stale running manifest: ${id}`);
    } catch (e) {
      getRuntime().logger?.warn?.(`Could not reconcile running manifest ${id}: ${e.message}`);
    }
  }
}

function getDefaultExportFromCjs (x) {
	return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, 'default') ? x['default'] : x;
}

var nodeCron = {};

var inlineScheduledTask = {};

var runner = {};

var createId = {};

const require$1 = createRequire(import.meta.url);
function __require() { return require$1("node:crypto"); }

var hasRequiredCreateId;

function requireCreateId () {
	if (hasRequiredCreateId) return createId;
	hasRequiredCreateId = 1;
	var __importDefault = (createId && createId.__importDefault) || function (mod) {
	    return (mod && mod.__esModule) ? mod : { "default": mod };
	};
	Object.defineProperty(createId, "__esModule", { value: true });
	createId.createID = createID;
	const node_crypto_1 = __importDefault(__require());
	function createID(prefix = '', length = 16) {
	    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	    const values = node_crypto_1.default.randomBytes(length);
	    const id = Array.from(values, v => charset[v % charset.length]).join('');
	    return prefix ? `${prefix}-${id}` : id;
	}
	
	return createId;
}

var logger = {};

var hasRequiredLogger;

function requireLogger () {
	if (hasRequiredLogger) return logger;
	hasRequiredLogger = 1;
	Object.defineProperty(logger, "__esModule", { value: true });
	const levelColors = {
	    INFO: '\x1b[36m',
	    WARN: '\x1b[33m',
	    ERROR: '\x1b[31m',
	    DEBUG: '\x1b[35m',
	};
	const GREEN = '\x1b[32m';
	const RESET = '\x1b[0m';
	function log(level, message, extra) {
	    const timestamp = new Date().toISOString();
	    const color = levelColors[level] ?? '';
	    const prefix = `[${timestamp}] [PID: ${process.pid}] ${GREEN}[NODE-CRON]${GREEN} ${color}[${level}]${RESET}`;
	    const output = `${prefix} ${message}`;
	    switch (level) {
	        case 'ERROR':
	            console.error(output, extra ?? '');
	            break;
	        case 'DEBUG':
	            console.debug(output, extra ?? '');
	            break;
	        case 'WARN':
	            console.warn(output);
	            break;
	        case 'INFO':
	        default:
	            console.info(output);
	            break;
	    }
	}
	const logger$1 = {
	    info(message) {
	        log('INFO', message);
	    },
	    warn(message) {
	        log('WARN', message);
	    },
	    error(message, err) {
	        if (message instanceof Error) {
	            log('ERROR', message.message, message);
	        }
	        else {
	            log('ERROR', message, err);
	        }
	    },
	    debug(message, err) {
	        if (message instanceof Error) {
	            log('DEBUG', message.message, message);
	        }
	        else {
	            log('DEBUG', message, err);
	        }
	    },
	};
	logger.default = logger$1;
	
	return logger;
}

var trackedPromise = {};

var hasRequiredTrackedPromise;

function requireTrackedPromise () {
	if (hasRequiredTrackedPromise) return trackedPromise;
	hasRequiredTrackedPromise = 1;
	Object.defineProperty(trackedPromise, "__esModule", { value: true });
	trackedPromise.TrackedPromise = void 0;
	class TrackedPromise {
	    promise;
	    error;
	    state;
	    value;
	    constructor(executor) {
	        this.state = 'pending';
	        this.promise = new Promise((resolve, reject) => {
	            executor((value) => {
	                this.state = 'fulfilled';
	                this.value = value;
	                resolve(value);
	            }, (error) => {
	                this.state = 'rejected';
	                this.error = error;
	                reject(error);
	            });
	        });
	    }
	    getPromise() {
	        return this.promise;
	    }
	    getState() {
	        return this.state;
	    }
	    isPending() {
	        return this.state === 'pending';
	    }
	    isFulfilled() {
	        return this.state === 'fulfilled';
	    }
	    isRejected() {
	        return this.state === 'rejected';
	    }
	    getValue() {
	        return this.value;
	    }
	    getError() {
	        return this.error;
	    }
	    then(onfulfilled, onrejected) {
	        return this.promise.then(onfulfilled, onrejected);
	    }
	    catch(onrejected) {
	        return this.promise.catch(onrejected);
	    }
	    finally(onfinally) {
	        return this.promise.finally(onfinally);
	    }
	}
	trackedPromise.TrackedPromise = TrackedPromise;
	
	return trackedPromise;
}

var hasRequiredRunner;

function requireRunner () {
	if (hasRequiredRunner) return runner;
	hasRequiredRunner = 1;
	var __importDefault = (runner && runner.__importDefault) || function (mod) {
	    return (mod && mod.__esModule) ? mod : { "default": mod };
	};
	Object.defineProperty(runner, "__esModule", { value: true });
	runner.Runner = void 0;
	const create_id_1 = requireCreateId();
	const logger_1 = __importDefault(requireLogger());
	const tracked_promise_1 = requireTrackedPromise();
	function emptyOnFn() { }
	function emptyHookFn() { return true; }
	function defaultOnError(date, error) {
	    logger_1.default.error('Task failed with error!', error);
	}
	class Runner {
	    timeMatcher;
	    onMatch;
	    noOverlap;
	    maxExecutions;
	    maxRandomDelay;
	    runCount;
	    running;
	    heartBeatTimeout;
	    onMissedExecution;
	    onOverlap;
	    onError;
	    beforeRun;
	    onFinished;
	    onMaxExecutions;
	    constructor(timeMatcher, onMatch, options) {
	        this.timeMatcher = timeMatcher;
	        this.onMatch = onMatch;
	        this.noOverlap = options == undefined || options.noOverlap === undefined ? false : options.noOverlap;
	        this.maxExecutions = options?.maxExecutions;
	        this.maxRandomDelay = options?.maxRandomDelay || 0;
	        this.onMissedExecution = options?.onMissedExecution || emptyOnFn;
	        this.onOverlap = options?.onOverlap || emptyOnFn;
	        this.onError = options?.onError || defaultOnError;
	        this.onFinished = options?.onFinished || emptyHookFn;
	        this.beforeRun = options?.beforeRun || emptyHookFn;
	        this.onMaxExecutions = options?.onMaxExecutions || emptyOnFn;
	        this.runCount = 0;
	        this.running = false;
	    }
	    start() {
	        this.running = true;
	        let lastExecution;
	        let expectedNextExecution;
	        const scheduleNextHeartBeat = (currentDate) => {
	            if (this.running) {
	                clearTimeout(this.heartBeatTimeout);
	                this.heartBeatTimeout = setTimeout(heartBeat, getDelay(this.timeMatcher, currentDate));
	            }
	        };
	        const runTask = (date) => {
	            return new Promise(async (resolve) => {
	                const execution = {
	                    id: (0, create_id_1.createID)('exec'),
	                    reason: 'scheduled'
	                };
	                const shouldExecute = await this.beforeRun(date, execution);
	                const randomDelay = Math.floor(Math.random() * this.maxRandomDelay);
	                if (shouldExecute) {
	                    setTimeout(async () => {
	                        try {
	                            this.runCount++;
	                            execution.startedAt = new Date();
	                            const result = await this.onMatch(date, execution);
	                            execution.finishedAt = new Date();
	                            execution.result = result;
	                            this.onFinished(date, execution);
	                            if (this.maxExecutions && this.runCount >= this.maxExecutions) {
	                                this.onMaxExecutions(date);
	                                this.stop();
	                            }
	                        }
	                        catch (error) {
	                            execution.finishedAt = new Date();
	                            execution.error = error;
	                            this.onError(date, error, execution);
	                        }
	                        resolve(true);
	                    }, randomDelay);
	                }
	            });
	        };
	        const checkAndRun = (date) => {
	            return new tracked_promise_1.TrackedPromise(async (resolve, reject) => {
	                try {
	                    if (this.timeMatcher.match(date)) {
	                        await runTask(date);
	                    }
	                    resolve(true);
	                }
	                catch (err) {
	                    reject(err);
	                }
	            });
	        };
	        const heartBeat = async () => {
	            const currentDate = nowWithoutMs();
	            if (expectedNextExecution && expectedNextExecution.getTime() < currentDate.getTime()) {
	                while (expectedNextExecution.getTime() < currentDate.getTime()) {
	                    logger_1.default.warn(`missed execution at ${expectedNextExecution}! Possible blocking IO or high CPU user at the same process used by node-cron.`);
	                    expectedNextExecution = this.timeMatcher.getNextMatch(expectedNextExecution);
	                    runAsync(this.onMissedExecution, expectedNextExecution, defaultOnError);
	                }
	            }
	            if (lastExecution && lastExecution.getState() === 'pending') {
	                runAsync(this.onOverlap, currentDate, defaultOnError);
	                if (this.noOverlap) {
	                    logger_1.default.warn('task still running, new execution blocked by overlap prevention!');
	                    expectedNextExecution = this.timeMatcher.getNextMatch(currentDate);
	                    scheduleNextHeartBeat(currentDate);
	                    return;
	                }
	            }
	            lastExecution = checkAndRun(currentDate);
	            expectedNextExecution = this.timeMatcher.getNextMatch(currentDate);
	            scheduleNextHeartBeat(currentDate);
	        };
	        this.heartBeatTimeout = setTimeout(() => {
	            heartBeat();
	        }, getDelay(this.timeMatcher, nowWithoutMs()));
	    }
	    nextRun() {
	        return this.timeMatcher.getNextMatch(new Date());
	    }
	    stop() {
	        this.running = false;
	        if (this.heartBeatTimeout) {
	            clearTimeout(this.heartBeatTimeout);
	            this.heartBeatTimeout = undefined;
	        }
	    }
	    isStarted() {
	        return !!this.heartBeatTimeout && this.running;
	    }
	    isStopped() {
	        return !this.isStarted();
	    }
	    async execute() {
	        const date = new Date();
	        const execution = {
	            id: (0, create_id_1.createID)('exec'),
	            reason: 'invoked'
	        };
	        try {
	            const shouldExecute = await this.beforeRun(date, execution);
	            if (shouldExecute) {
	                this.runCount++;
	                execution.startedAt = new Date();
	                const result = await this.onMatch(date, execution);
	                execution.finishedAt = new Date();
	                execution.result = result;
	                this.onFinished(date, execution);
	            }
	        }
	        catch (error) {
	            execution.finishedAt = new Date();
	            execution.error = error;
	            this.onError(date, error, execution);
	        }
	    }
	}
	runner.Runner = Runner;
	async function runAsync(fn, date, onError) {
	    try {
	        await fn(date);
	    }
	    catch (error) {
	        onError(date, error);
	    }
	}
	function getDelay(timeMatcher, currentDate) {
	    const maxDelay = 86400000;
	    const nextRun = timeMatcher.getNextMatch(currentDate);
	    const now = new Date();
	    const delay = nextRun.getTime() - now.getTime();
	    if (delay > maxDelay) {
	        return maxDelay;
	    }
	    return Math.max(0, delay);
	}
	function nowWithoutMs() {
	    const date = new Date();
	    date.setMilliseconds(0);
	    return date;
	}
	
	return runner;
}

var timeMatcher = {};

var convertion = {};

var monthNamesConversion = {};

var hasRequiredMonthNamesConversion;

function requireMonthNamesConversion () {
	if (hasRequiredMonthNamesConversion) return monthNamesConversion;
	hasRequiredMonthNamesConversion = 1;
	Object.defineProperty(monthNamesConversion, "__esModule", { value: true });
	monthNamesConversion.default = (() => {
	    const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
	        'august', 'september', 'october', 'november', 'december'];
	    const shortMonths = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug',
	        'sep', 'oct', 'nov', 'dec'];
	    function convertMonthName(expression, items) {
	        for (let i = 0; i < items.length; i++) {
	            expression = expression.replace(new RegExp(items[i], 'gi'), i + 1);
	        }
	        return expression;
	    }
	    function interprete(monthExpression) {
	        monthExpression = convertMonthName(monthExpression, months);
	        monthExpression = convertMonthName(monthExpression, shortMonths);
	        return monthExpression;
	    }
	    return interprete;
	})();
	
	return monthNamesConversion;
}

var weekDayNamesConversion = {};

var hasRequiredWeekDayNamesConversion;

function requireWeekDayNamesConversion () {
	if (hasRequiredWeekDayNamesConversion) return weekDayNamesConversion;
	hasRequiredWeekDayNamesConversion = 1;
	Object.defineProperty(weekDayNamesConversion, "__esModule", { value: true });
	weekDayNamesConversion.default = (() => {
	    const weekDays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday',
	        'friday', 'saturday'];
	    const shortWeekDays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
	    function convertWeekDayName(expression, items) {
	        for (let i = 0; i < items.length; i++) {
	            expression = expression.replace(new RegExp(items[i], 'gi'), i);
	        }
	        return expression;
	    }
	    function convertWeekDays(expression) {
	        expression = expression.replace('7', '0');
	        expression = convertWeekDayName(expression, weekDays);
	        return convertWeekDayName(expression, shortWeekDays);
	    }
	    return convertWeekDays;
	})();
	
	return weekDayNamesConversion;
}

var asteriskToRangeConversion = {};

var hasRequiredAsteriskToRangeConversion;

function requireAsteriskToRangeConversion () {
	if (hasRequiredAsteriskToRangeConversion) return asteriskToRangeConversion;
	hasRequiredAsteriskToRangeConversion = 1;
	Object.defineProperty(asteriskToRangeConversion, "__esModule", { value: true });
	asteriskToRangeConversion.default = (() => {
	    function convertAsterisk(expression, replecement) {
	        if (expression.indexOf('*') !== -1) {
	            return expression.replace('*', replecement);
	        }
	        return expression;
	    }
	    function convertAsterisksToRanges(expressions) {
	        expressions[0] = convertAsterisk(expressions[0], '0-59');
	        expressions[1] = convertAsterisk(expressions[1], '0-59');
	        expressions[2] = convertAsterisk(expressions[2], '0-23');
	        expressions[3] = convertAsterisk(expressions[3], '1-31');
	        expressions[4] = convertAsterisk(expressions[4], '1-12');
	        expressions[5] = convertAsterisk(expressions[5], '0-6');
	        return expressions;
	    }
	    return convertAsterisksToRanges;
	})();
	
	return asteriskToRangeConversion;
}

var rangeConversion = {};

var hasRequiredRangeConversion;

function requireRangeConversion () {
	if (hasRequiredRangeConversion) return rangeConversion;
	hasRequiredRangeConversion = 1;
	Object.defineProperty(rangeConversion, "__esModule", { value: true });
	rangeConversion.default = (() => {
	    function replaceWithRange(expression, text, init, end, stepTxt) {
	        const step = parseInt(stepTxt);
	        const numbers = [];
	        let last = parseInt(end);
	        let first = parseInt(init);
	        if (first > last) {
	            last = parseInt(init);
	            first = parseInt(end);
	        }
	        for (let i = first; i <= last; i += step) {
	            numbers.push(i);
	        }
	        return expression.replace(new RegExp(text, 'i'), numbers.join());
	    }
	    function convertRange(expression) {
	        const rangeRegEx = /(\d+)-(\d+)(\/(\d+)|)/;
	        let match = rangeRegEx.exec(expression);
	        while (match !== null && match.length > 0) {
	            expression = replaceWithRange(expression, match[0], match[1], match[2], match[4] || '1');
	            match = rangeRegEx.exec(expression);
	        }
	        return expression;
	    }
	    function convertAllRanges(expressions) {
	        for (let i = 0; i < expressions.length; i++) {
	            expressions[i] = convertRange(expressions[i]);
	        }
	        return expressions;
	    }
	    return convertAllRanges;
	})();
	
	return rangeConversion;
}

var hasRequiredConvertion;

function requireConvertion () {
	if (hasRequiredConvertion) return convertion;
	hasRequiredConvertion = 1;
	var __importDefault = (convertion && convertion.__importDefault) || function (mod) {
	    return (mod && mod.__esModule) ? mod : { "default": mod };
	};
	Object.defineProperty(convertion, "__esModule", { value: true });
	const month_names_conversion_1 = __importDefault(requireMonthNamesConversion());
	const week_day_names_conversion_1 = __importDefault(requireWeekDayNamesConversion());
	const asterisk_to_range_conversion_1 = __importDefault(requireAsteriskToRangeConversion());
	const range_conversion_1 = __importDefault(requireRangeConversion());
	convertion.default = (() => {
	    function appendSeccondExpression(expressions) {
	        if (expressions.length === 5) {
	            return ['0'].concat(expressions);
	        }
	        return expressions;
	    }
	    function removeSpaces(str) {
	        return str.replace(/\s{2,}/g, ' ').trim();
	    }
	    function normalizeIntegers(expressions) {
	        for (let i = 0; i < expressions.length; i++) {
	            const numbers = expressions[i].split(',');
	            for (let j = 0; j < numbers.length; j++) {
	                numbers[j] = parseInt(numbers[j]);
	            }
	            expressions[i] = numbers;
	        }
	        return expressions;
	    }
	    function interprete(expression) {
	        let expressions = removeSpaces(`${expression}`).split(' ');
	        expressions = appendSeccondExpression(expressions);
	        expressions[4] = (0, month_names_conversion_1.default)(expressions[4]);
	        expressions[5] = (0, week_day_names_conversion_1.default)(expressions[5]);
	        expressions = (0, asterisk_to_range_conversion_1.default)(expressions);
	        expressions = (0, range_conversion_1.default)(expressions);
	        expressions = normalizeIntegers(expressions);
	        return expressions;
	    }
	    return interprete;
	})();
	
	return convertion;
}

var localizedTime = {};

var hasRequiredLocalizedTime;

function requireLocalizedTime () {
	if (hasRequiredLocalizedTime) return localizedTime;
	hasRequiredLocalizedTime = 1;
	Object.defineProperty(localizedTime, "__esModule", { value: true });
	localizedTime.LocalizedTime = void 0;
	class LocalizedTime {
	    timestamp;
	    parts;
	    timezone;
	    constructor(date, timezone) {
	        this.timestamp = date.getTime();
	        this.timezone = timezone;
	        this.parts = buildDateParts(date, timezone);
	    }
	    toDate() {
	        return new Date(this.timestamp);
	    }
	    toISO() {
	        const gmt = this.parts.gmt.replace(/^GMT/, '');
	        const offset = gmt ? gmt : 'Z';
	        const pad = (n) => String(n).padStart(2, '0');
	        return `${this.parts.year}-${pad(this.parts.month)}-${pad(this.parts.day)}`
	            + `T${pad(this.parts.hour)}:${pad(this.parts.minute)}:${pad(this.parts.second)}`
	            + `.${String(this.parts.milisecond).padStart(3, '0')}`
	            + offset;
	    }
	    getParts() {
	        return this.parts;
	    }
	    set(field, value) {
	        this.parts[field] = value;
	        const newDate = new Date(this.toISO());
	        this.timestamp = newDate.getTime();
	        this.parts = buildDateParts(newDate, this.timezone);
	    }
	}
	localizedTime.LocalizedTime = LocalizedTime;
	function buildDateParts(date, timezone) {
	    const dftOptions = {
	        year: 'numeric',
	        month: '2-digit',
	        day: '2-digit',
	        hour: '2-digit',
	        minute: '2-digit',
	        second: '2-digit',
	        weekday: 'short',
	        hour12: false
	    };
	    if (timezone) {
	        dftOptions.timeZone = timezone;
	    }
	    const dateFormat = new Intl.DateTimeFormat('en-US', dftOptions);
	    const parts = dateFormat.formatToParts(date).filter(part => {
	        return part.type !== 'literal';
	    }).reduce((acc, part) => {
	        acc[part.type] = part.value;
	        return acc;
	    }, {});
	    return {
	        day: parseInt(parts.day),
	        month: parseInt(parts.month),
	        year: parseInt(parts.year),
	        hour: parts.hour === '24' ? 0 : parseInt(parts.hour),
	        minute: parseInt(parts.minute),
	        second: parseInt(parts.second),
	        milisecond: date.getMilliseconds(),
	        weekday: parts.weekday,
	        gmt: getTimezoneGMT(date, timezone)
	    };
	}
	function getTimezoneGMT(date, timezone) {
	    const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
	    const tzDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
	    let offsetInMinutes = (utcDate.getTime() - tzDate.getTime()) / 60000;
	    const sign = offsetInMinutes <= 0 ? '+' : '-';
	    offsetInMinutes = Math.abs(offsetInMinutes);
	    if (offsetInMinutes === 0)
	        return 'Z';
	    const hours = Math.floor(offsetInMinutes / 60).toString().padStart(2, '0');
	    const minutes = Math.floor(offsetInMinutes % 60).toString().padStart(2, '0');
	    return `GMT${sign}${hours}:${minutes}`;
	}
	
	return localizedTime;
}

var matcherWalker = {};

var hasRequiredMatcherWalker;

function requireMatcherWalker () {
	if (hasRequiredMatcherWalker) return matcherWalker;
	hasRequiredMatcherWalker = 1;
	var __importDefault = (matcherWalker && matcherWalker.__importDefault) || function (mod) {
	    return (mod && mod.__esModule) ? mod : { "default": mod };
	};
	Object.defineProperty(matcherWalker, "__esModule", { value: true });
	matcherWalker.MatcherWalker = void 0;
	const convertion_1 = __importDefault(requireConvertion());
	const localized_time_1 = requireLocalizedTime();
	const time_matcher_1 = requireTimeMatcher();
	const week_day_names_conversion_1 = __importDefault(requireWeekDayNamesConversion());
	class MatcherWalker {
	    cronExpression;
	    baseDate;
	    pattern;
	    expressions;
	    timeMatcher;
	    timezone;
	    constructor(cronExpression, baseDate, timezone) {
	        this.cronExpression = cronExpression;
	        this.baseDate = baseDate;
	        this.timeMatcher = new time_matcher_1.TimeMatcher(cronExpression, timezone);
	        this.timezone = timezone;
	        this.expressions = (0, convertion_1.default)(cronExpression);
	    }
	    isMatching() {
	        return this.timeMatcher.match(this.baseDate);
	    }
	    matchNext() {
	        const findNextDateIgnoringWeekday = () => {
	            const baseDate = new Date(this.baseDate.getTime());
	            baseDate.setMilliseconds(0);
	            const localTime = new localized_time_1.LocalizedTime(baseDate, this.timezone);
	            const dateParts = localTime.getParts();
	            const date = new localized_time_1.LocalizedTime(localTime.toDate(), this.timezone);
	            const seconds = this.expressions[0];
	            const nextSecond = availableValue(seconds, dateParts.second);
	            if (nextSecond) {
	                date.set('second', nextSecond);
	                if (this.timeMatcher.match(date.toDate())) {
	                    return date;
	                }
	            }
	            date.set('second', seconds[0]);
	            const minutes = this.expressions[1];
	            const nextMinute = availableValue(minutes, dateParts.minute);
	            if (nextMinute) {
	                date.set('minute', nextMinute);
	                if (this.timeMatcher.match(date.toDate())) {
	                    return date;
	                }
	            }
	            date.set('minute', minutes[0]);
	            const hours = this.expressions[2];
	            const nextHour = availableValue(hours, dateParts.hour);
	            if (nextHour) {
	                date.set('hour', nextHour);
	                if (this.timeMatcher.match(date.toDate())) {
	                    return date;
	                }
	            }
	            date.set('hour', hours[0]);
	            const days = this.expressions[3];
	            const nextDay = availableValue(days, dateParts.day);
	            if (nextDay) {
	                date.set('day', nextDay);
	                if (this.timeMatcher.match(date.toDate())) {
	                    return date;
	                }
	            }
	            date.set('day', days[0]);
	            const months = this.expressions[4];
	            const nextMonth = availableValue(months, dateParts.month);
	            if (nextMonth) {
	                date.set('month', nextMonth);
	                if (this.timeMatcher.match(date.toDate())) {
	                    return date;
	                }
	            }
	            date.set('year', date.getParts().year + 1);
	            date.set('month', months[0]);
	            return date;
	        };
	        const date = findNextDateIgnoringWeekday();
	        const weekdays = this.expressions[5];
	        let currentWeekday = parseInt((0, week_day_names_conversion_1.default)(date.getParts().weekday));
	        while (!(weekdays.indexOf(currentWeekday) > -1)) {
	            date.set('year', date.getParts().year + 1);
	            currentWeekday = parseInt((0, week_day_names_conversion_1.default)(date.getParts().weekday));
	        }
	        return date;
	    }
	}
	matcherWalker.MatcherWalker = MatcherWalker;
	function availableValue(values, currentValue) {
	    const availableValues = values.sort((a, b) => a - b).filter(s => s > currentValue);
	    if (availableValues.length > 0)
	        return availableValues[0];
	    return false;
	}
	
	return matcherWalker;
}

var hasRequiredTimeMatcher;

function requireTimeMatcher () {
	if (hasRequiredTimeMatcher) return timeMatcher;
	hasRequiredTimeMatcher = 1;
	var __importDefault = (timeMatcher && timeMatcher.__importDefault) || function (mod) {
	    return (mod && mod.__esModule) ? mod : { "default": mod };
	};
	Object.defineProperty(timeMatcher, "__esModule", { value: true });
	timeMatcher.TimeMatcher = void 0;
	const index_1 = __importDefault(requireConvertion());
	const week_day_names_conversion_1 = __importDefault(requireWeekDayNamesConversion());
	const localized_time_1 = requireLocalizedTime();
	const matcher_walker_1 = requireMatcherWalker();
	function matchValue(allowedValues, value) {
	    return allowedValues.indexOf(value) !== -1;
	}
	class TimeMatcher {
	    timezone;
	    pattern;
	    expressions;
	    constructor(pattern, timezone) {
	        this.timezone = timezone;
	        this.pattern = pattern;
	        this.expressions = (0, index_1.default)(pattern);
	    }
	    match(date) {
	        const localizedTime = new localized_time_1.LocalizedTime(date, this.timezone);
	        const parts = localizedTime.getParts();
	        const runOnSecond = matchValue(this.expressions[0], parts.second);
	        const runOnMinute = matchValue(this.expressions[1], parts.minute);
	        const runOnHour = matchValue(this.expressions[2], parts.hour);
	        const runOnDay = matchValue(this.expressions[3], parts.day);
	        const runOnMonth = matchValue(this.expressions[4], parts.month);
	        const runOnWeekDay = matchValue(this.expressions[5], parseInt((0, week_day_names_conversion_1.default)(parts.weekday)));
	        return runOnSecond && runOnMinute && runOnHour && runOnDay && runOnMonth && runOnWeekDay;
	    }
	    getNextMatch(date) {
	        const walker = new matcher_walker_1.MatcherWalker(this.pattern, date, this.timezone);
	        const next = walker.matchNext();
	        return next.toDate();
	    }
	}
	timeMatcher.TimeMatcher = TimeMatcher;
	
	return timeMatcher;
}

var stateMachine = {};

var hasRequiredStateMachine;

function requireStateMachine () {
	if (hasRequiredStateMachine) return stateMachine;
	hasRequiredStateMachine = 1;
	Object.defineProperty(stateMachine, "__esModule", { value: true });
	stateMachine.StateMachine = void 0;
	const allowedTransitions = {
	    'stopped': ['stopped', 'idle', 'destroyed'],
	    'idle': ['idle', 'running', 'stopped', 'destroyed'],
	    'running': ['running', 'idle', 'stopped', 'destroyed'],
	    'destroyed': ['destroyed']
	};
	class StateMachine {
	    state;
	    constructor(initial = 'stopped') {
	        this.state = initial;
	    }
	    changeState(state) {
	        if (allowedTransitions[this.state].includes(state)) {
	            this.state = state;
	        }
	        else {
	            throw new Error(`invalid transition from ${this.state} to ${state}`);
	        }
	    }
	}
	stateMachine.StateMachine = StateMachine;
	
	return stateMachine;
}

var hasRequiredInlineScheduledTask;

function requireInlineScheduledTask () {
	if (hasRequiredInlineScheduledTask) return inlineScheduledTask;
	hasRequiredInlineScheduledTask = 1;
	var __importDefault = (inlineScheduledTask && inlineScheduledTask.__importDefault) || function (mod) {
	    return (mod && mod.__esModule) ? mod : { "default": mod };
	};
	Object.defineProperty(inlineScheduledTask, "__esModule", { value: true });
	inlineScheduledTask.InlineScheduledTask = void 0;
	const events_1 = __importDefault(require$$0);
	const runner_1 = requireRunner();
	const time_matcher_1 = requireTimeMatcher();
	const create_id_1 = requireCreateId();
	const state_machine_1 = requireStateMachine();
	const logger_1 = __importDefault(requireLogger());
	const localized_time_1 = requireLocalizedTime();
	class TaskEmitter extends events_1.default {
	}
	class InlineScheduledTask {
	    emitter;
	    cronExpression;
	    timeMatcher;
	    runner;
	    id;
	    name;
	    stateMachine;
	    timezone;
	    constructor(cronExpression, taskFn, options) {
	        this.emitter = new TaskEmitter();
	        this.cronExpression = cronExpression;
	        this.id = (0, create_id_1.createID)('task', 12);
	        this.name = options?.name || this.id;
	        this.timezone = options?.timezone;
	        this.timeMatcher = new time_matcher_1.TimeMatcher(cronExpression, options?.timezone);
	        this.stateMachine = new state_machine_1.StateMachine();
	        const runnerOptions = {
	            timezone: options?.timezone,
	            noOverlap: options?.noOverlap,
	            maxExecutions: options?.maxExecutions,
	            maxRandomDelay: options?.maxRandomDelay,
	            beforeRun: (date, execution) => {
	                if (execution.reason === 'scheduled') {
	                    this.changeState('running');
	                }
	                this.emitter.emit('execution:started', this.createContext(date, execution));
	                return true;
	            },
	            onFinished: (date, execution) => {
	                if (execution.reason === 'scheduled') {
	                    this.changeState('idle');
	                }
	                this.emitter.emit('execution:finished', this.createContext(date, execution));
	                return true;
	            },
	            onError: (date, error, execution) => {
	                logger_1.default.error(error);
	                this.emitter.emit('execution:failed', this.createContext(date, execution));
	                this.changeState('idle');
	            },
	            onOverlap: (date) => {
	                this.emitter.emit('execution:overlap', this.createContext(date));
	            },
	            onMissedExecution: (date) => {
	                this.emitter.emit('execution:missed', this.createContext(date));
	            },
	            onMaxExecutions: (date) => {
	                this.emitter.emit('execution:maxReached', this.createContext(date));
	                this.destroy();
	            }
	        };
	        this.runner = new runner_1.Runner(this.timeMatcher, (date, execution) => {
	            return taskFn(this.createContext(date, execution));
	        }, runnerOptions);
	    }
	    getNextRun() {
	        if (this.stateMachine.state !== 'stopped') {
	            return this.runner.nextRun();
	        }
	        return null;
	    }
	    changeState(state) {
	        if (this.runner.isStarted()) {
	            this.stateMachine.changeState(state);
	        }
	    }
	    start() {
	        if (this.runner.isStopped()) {
	            this.runner.start();
	            this.stateMachine.changeState('idle');
	            this.emitter.emit('task:started', this.createContext(new Date()));
	        }
	    }
	    stop() {
	        if (this.runner.isStarted()) {
	            this.runner.stop();
	            this.stateMachine.changeState('stopped');
	            this.emitter.emit('task:stopped', this.createContext(new Date()));
	        }
	    }
	    getStatus() {
	        return this.stateMachine.state;
	    }
	    destroy() {
	        if (this.stateMachine.state === 'destroyed')
	            return;
	        this.stop();
	        this.stateMachine.changeState('destroyed');
	        this.emitter.emit('task:destroyed', this.createContext(new Date()));
	    }
	    execute() {
	        return new Promise((resolve, reject) => {
	            const onFail = (context) => {
	                this.off('execution:finished', onFail);
	                reject(context.execution?.error);
	            };
	            const onFinished = (context) => {
	                this.off('execution:failed', onFail);
	                resolve(context.execution?.result);
	            };
	            this.once('execution:finished', onFinished);
	            this.once('execution:failed', onFail);
	            this.runner.execute();
	        });
	    }
	    on(event, fun) {
	        this.emitter.on(event, fun);
	    }
	    off(event, fun) {
	        this.emitter.off(event, fun);
	    }
	    once(event, fun) {
	        this.emitter.once(event, fun);
	    }
	    createContext(executionDate, execution) {
	        const localTime = new localized_time_1.LocalizedTime(executionDate, this.timezone);
	        const ctx = {
	            date: localTime.toDate(),
	            dateLocalIso: localTime.toISO(),
	            triggeredAt: new Date(),
	            task: this,
	            execution: execution
	        };
	        return ctx;
	    }
	}
	inlineScheduledTask.InlineScheduledTask = InlineScheduledTask;
	
	return inlineScheduledTask;
}

var taskRegistry = {};

var hasRequiredTaskRegistry;

function requireTaskRegistry () {
	if (hasRequiredTaskRegistry) return taskRegistry;
	hasRequiredTaskRegistry = 1;
	Object.defineProperty(taskRegistry, "__esModule", { value: true });
	taskRegistry.TaskRegistry = void 0;
	const tasks = new Map();
	class TaskRegistry {
	    add(task) {
	        if (this.has(task.id)) {
	            throw Error(`task ${task.id} already registred!`);
	        }
	        tasks.set(task.id, task);
	        task.on('task:destroyed', () => {
	            this.remove(task);
	        });
	    }
	    get(taskId) {
	        return tasks.get(taskId);
	    }
	    remove(task) {
	        if (this.has(task.id)) {
	            task?.destroy();
	            tasks.delete(task.id);
	        }
	    }
	    all() {
	        return tasks;
	    }
	    has(taskId) {
	        return tasks.has(taskId);
	    }
	    killAll() {
	        tasks.forEach(id => this.remove(id));
	    }
	}
	taskRegistry.TaskRegistry = TaskRegistry;
	
	return taskRegistry;
}

var patternValidation = {};

var hasRequiredPatternValidation;

function requirePatternValidation () {
	if (hasRequiredPatternValidation) return patternValidation;
	hasRequiredPatternValidation = 1;
	var __importDefault = (patternValidation && patternValidation.__importDefault) || function (mod) {
	    return (mod && mod.__esModule) ? mod : { "default": mod };
	};
	Object.defineProperty(patternValidation, "__esModule", { value: true });
	const index_1 = __importDefault(requireConvertion());
	const validationRegex = /^(?:\d+|\*|\*\/\d+)$/;
	function isValidExpression(expression, min, max) {
	    const options = expression;
	    for (const option of options) {
	        const optionAsInt = parseInt(option, 10);
	        if ((!Number.isNaN(optionAsInt) &&
	            (optionAsInt < min || optionAsInt > max)) ||
	            !validationRegex.test(option))
	            return false;
	    }
	    return true;
	}
	function isInvalidSecond(expression) {
	    return !isValidExpression(expression, 0, 59);
	}
	function isInvalidMinute(expression) {
	    return !isValidExpression(expression, 0, 59);
	}
	function isInvalidHour(expression) {
	    return !isValidExpression(expression, 0, 23);
	}
	function isInvalidDayOfMonth(expression) {
	    return !isValidExpression(expression, 1, 31);
	}
	function isInvalidMonth(expression) {
	    return !isValidExpression(expression, 1, 12);
	}
	function isInvalidWeekDay(expression) {
	    return !isValidExpression(expression, 0, 7);
	}
	function validateFields(patterns, executablePatterns) {
	    if (isInvalidSecond(executablePatterns[0]))
	        throw new Error(`${patterns[0]} is a invalid expression for second`);
	    if (isInvalidMinute(executablePatterns[1]))
	        throw new Error(`${patterns[1]} is a invalid expression for minute`);
	    if (isInvalidHour(executablePatterns[2]))
	        throw new Error(`${patterns[2]} is a invalid expression for hour`);
	    if (isInvalidDayOfMonth(executablePatterns[3]))
	        throw new Error(`${patterns[3]} is a invalid expression for day of month`);
	    if (isInvalidMonth(executablePatterns[4]))
	        throw new Error(`${patterns[4]} is a invalid expression for month`);
	    if (isInvalidWeekDay(executablePatterns[5]))
	        throw new Error(`${patterns[5]} is a invalid expression for week day`);
	}
	function validate(pattern) {
	    if (typeof pattern !== 'string')
	        throw new TypeError('pattern must be a string!');
	    const patterns = pattern.split(' ');
	    const executablePatterns = (0, index_1.default)(pattern);
	    if (patterns.length === 5)
	        patterns.unshift('0');
	    validateFields(patterns, executablePatterns);
	}
	patternValidation.default = validate;
	
	return patternValidation;
}

var backgroundScheduledTask = {};

var hasRequiredBackgroundScheduledTask;

function requireBackgroundScheduledTask () {
	if (hasRequiredBackgroundScheduledTask) return backgroundScheduledTask;
	hasRequiredBackgroundScheduledTask = 1;
	var __importDefault = (backgroundScheduledTask && backgroundScheduledTask.__importDefault) || function (mod) {
	    return (mod && mod.__esModule) ? mod : { "default": mod };
	};
	Object.defineProperty(backgroundScheduledTask, "__esModule", { value: true });
	const path_1 = require$$0$1;
	const child_process_1 = require$$1;
	const create_id_1 = requireCreateId();
	const stream_1 = require$$3;
	const state_machine_1 = requireStateMachine();
	const localized_time_1 = requireLocalizedTime();
	const logger_1 = __importDefault(requireLogger());
	const time_matcher_1 = requireTimeMatcher();
	const daemonPath = (0, path_1.resolve)(__dirname, 'daemon.js');
	class TaskEmitter extends stream_1.EventEmitter {
	}
	class BackgroundScheduledTask {
	    emitter;
	    id;
	    name;
	    cronExpression;
	    taskPath;
	    options;
	    forkProcess;
	    stateMachine;
	    constructor(cronExpression, taskPath, options) {
	        this.cronExpression = cronExpression;
	        this.taskPath = taskPath;
	        this.options = options;
	        this.id = (0, create_id_1.createID)('task');
	        this.name = options?.name || this.id;
	        this.emitter = new TaskEmitter();
	        this.stateMachine = new state_machine_1.StateMachine('stopped');
	        this.on('task:stopped', () => {
	            this.forkProcess?.kill();
	            this.forkProcess = undefined;
	            this.stateMachine.changeState('stopped');
	        });
	        this.on('task:destroyed', () => {
	            this.forkProcess?.kill();
	            this.forkProcess = undefined;
	            this.stateMachine.changeState('destroyed');
	        });
	    }
	    getNextRun() {
	        if (this.stateMachine.state !== 'stopped') {
	            const timeMatcher = new time_matcher_1.TimeMatcher(this.cronExpression, this.options?.timezone);
	            return timeMatcher.getNextMatch(new Date());
	        }
	        return null;
	    }
	    start() {
	        return new Promise((resolve, reject) => {
	            if (this.forkProcess) {
	                return resolve(undefined);
	            }
	            const timeout = setTimeout(() => {
	                reject(new Error('Start operation timed out'));
	            }, 5000);
	            try {
	                this.forkProcess = (0, child_process_1.fork)(daemonPath);
	                this.forkProcess.on('error', (err) => {
	                    clearTimeout(timeout);
	                    reject(new Error(`Error on daemon: ${err.message}`));
	                });
	                this.forkProcess.on('exit', (code, signal) => {
	                    if (code !== 0 && signal !== 'SIGTERM') {
	                        const erro = new Error(`node-cron daemon exited with code ${code || signal}`);
	                        logger_1.default.error(erro);
	                        clearTimeout(timeout);
	                        reject(erro);
	                    }
	                });
	                this.forkProcess.on('message', (message) => {
	                    if (message.jsonError) {
	                        if (message.context?.execution) {
	                            message.context.execution.error = deserializeError(message.jsonError);
	                            delete message.jsonError;
	                        }
	                    }
	                    if (message.context?.task?.state) {
	                        this.stateMachine.changeState(message.context?.task?.state);
	                    }
	                    if (message.context) {
	                        const execution = message.context?.execution;
	                        delete execution?.hasError;
	                        const context = this.createContext(new Date(message.context.date), execution);
	                        this.emitter.emit(message.event, context);
	                    }
	                });
	                this.once('task:started', () => {
	                    this.stateMachine.changeState('idle');
	                    clearTimeout(timeout);
	                    resolve(undefined);
	                });
	                this.forkProcess.send({
	                    command: 'task:start',
	                    path: this.taskPath,
	                    cron: this.cronExpression,
	                    options: this.options
	                });
	            }
	            catch (error) {
	                reject(error);
	            }
	        });
	    }
	    stop() {
	        return new Promise((resolve, reject) => {
	            if (!this.forkProcess) {
	                return resolve(undefined);
	            }
	            const timeoutId = setTimeout(() => {
	                clearTimeout(timeoutId);
	                reject(new Error('Stop operation timed out'));
	            }, 5000);
	            const cleanupAndResolve = () => {
	                clearTimeout(timeoutId);
	                this.off('task:stopped', onStopped);
	                this.forkProcess = undefined;
	                resolve(undefined);
	            };
	            const onStopped = () => {
	                cleanupAndResolve();
	            };
	            this.once('task:stopped', onStopped);
	            this.forkProcess.send({
	                command: 'task:stop'
	            });
	        });
	    }
	    getStatus() {
	        return this.stateMachine.state;
	    }
	    destroy() {
	        return new Promise((resolve, reject) => {
	            if (!this.forkProcess) {
	                return resolve(undefined);
	            }
	            const timeoutId = setTimeout(() => {
	                clearTimeout(timeoutId);
	                reject(new Error('Destroy operation timed out'));
	            }, 5000);
	            const onDestroy = () => {
	                clearTimeout(timeoutId);
	                this.off('task:destroyed', onDestroy);
	                resolve(undefined);
	            };
	            this.once('task:destroyed', onDestroy);
	            this.forkProcess.send({
	                command: 'task:destroy'
	            });
	        });
	    }
	    execute() {
	        return new Promise((resolve, reject) => {
	            if (!this.forkProcess) {
	                return reject(new Error('Cannot execute background task because it hasn\'t been started yet. Please initialize the task using the start() method before attempting to execute it.'));
	            }
	            const timeoutId = setTimeout(() => {
	                cleanupListeners();
	                reject(new Error('Execution timeout exceeded'));
	            }, 5000);
	            const cleanupListeners = () => {
	                clearTimeout(timeoutId);
	                this.off('execution:finished', onFinished);
	                this.off('execution:failed', onFail);
	            };
	            const onFinished = (context) => {
	                cleanupListeners();
	                resolve(context.execution?.result);
	            };
	            const onFail = (context) => {
	                cleanupListeners();
	                reject(context.execution?.error || new Error('Execution failed without specific error'));
	            };
	            this.once('execution:finished', onFinished);
	            this.once('execution:failed', onFail);
	            this.forkProcess.send({
	                command: 'task:execute'
	            });
	        });
	    }
	    on(event, fun) {
	        this.emitter.on(event, fun);
	    }
	    off(event, fun) {
	        this.emitter.off(event, fun);
	    }
	    once(event, fun) {
	        this.emitter.once(event, fun);
	    }
	    createContext(executionDate, execution) {
	        const localTime = new localized_time_1.LocalizedTime(executionDate, this.options?.timezone);
	        const ctx = {
	            date: localTime.toDate(),
	            dateLocalIso: localTime.toISO(),
	            triggeredAt: new Date(),
	            task: this,
	            execution: execution
	        };
	        return ctx;
	    }
	}
	function deserializeError(str) {
	    const data = JSON.parse(str);
	    const Err = globalThis[data.name] || Error;
	    const err = new Err(data.message);
	    if (data.stack) {
	        err.stack = data.stack;
	    }
	    Object.keys(data).forEach(key => {
	        if (!['name', 'message', 'stack'].includes(key)) {
	            err[key] = data[key];
	        }
	    });
	    return err;
	}
	backgroundScheduledTask.default = BackgroundScheduledTask;
	
	return backgroundScheduledTask;
}

var hasRequiredNodeCron;

function requireNodeCron () {
	if (hasRequiredNodeCron) return nodeCron;
	hasRequiredNodeCron = 1;
	(function (exports$1) {
		var __importDefault = (nodeCron && nodeCron.__importDefault) || function (mod) {
		    return (mod && mod.__esModule) ? mod : { "default": mod };
		};
		Object.defineProperty(exports$1, "__esModule", { value: true });
		exports$1.nodeCron = exports$1.getTask = exports$1.getTasks = void 0;
		exports$1.schedule = schedule;
		exports$1.createTask = createTask;
		exports$1.solvePath = solvePath;
		exports$1.validate = validate;
		const inline_scheduled_task_1 = requireInlineScheduledTask();
		const task_registry_1 = requireTaskRegistry();
		const pattern_validation_1 = __importDefault(requirePatternValidation());
		const background_scheduled_task_1 = __importDefault(requireBackgroundScheduledTask());
		const path_1 = __importDefault(require$$0$1);
		const url_1 = require$$5;
		const registry = new task_registry_1.TaskRegistry();
		function schedule(expression, func, options) {
		    const task = createTask(expression, func, options);
		    task.start();
		    return task;
		}
		function createTask(expression, func, options) {
		    let task;
		    if (func instanceof Function) {
		        task = new inline_scheduled_task_1.InlineScheduledTask(expression, func, options);
		    }
		    else {
		        const taskPath = solvePath(func);
		        task = new background_scheduled_task_1.default(expression, taskPath, options);
		    }
		    registry.add(task);
		    return task;
		}
		function solvePath(filePath) {
		    if (path_1.default.isAbsolute(filePath))
		        return (0, url_1.pathToFileURL)(filePath).href;
		    if (filePath.startsWith('file://'))
		        return filePath;
		    const stackLines = new Error().stack?.split('\n');
		    if (stackLines) {
		        stackLines?.shift();
		        const callerLine = stackLines?.find((line) => { return line.indexOf(__filename) === -1; });
		        const match = callerLine?.match(/(file:\/\/)?(((\/?)(\w:))?([/\\].+)):\d+:\d+/);
		        if (match) {
		            const dir = `${match[5] ?? ""}${path_1.default.dirname(match[6])}`;
		            return (0, url_1.pathToFileURL)(path_1.default.resolve(dir, filePath)).href;
		        }
		    }
		    throw new Error(`Could not locate task file ${filePath}`);
		}
		function validate(expression) {
		    try {
		        (0, pattern_validation_1.default)(expression);
		        return true;
		    }
		    catch (e) {
		        return false;
		    }
		}
		exports$1.getTasks = registry.all;
		exports$1.getTask = registry.get;
		exports$1.nodeCron = {
		    schedule,
		    createTask,
		    validate,
		    getTasks: exports$1.getTasks,
		    getTask: exports$1.getTask,
		};
		exports$1.default = exports$1.nodeCron;
		
	} (nodeCron));
	return nodeCron;
}

var nodeCronExports = requireNodeCron();
var cron = /*@__PURE__*/getDefaultExportFromCjs(nodeCronExports);

/**
 * Backup configuration persistence: read/validate/write `backup-config.json`.
 *
 * Stateless — paths are derived from {@link config} at call time, never at
 * import time.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */
function normalizeScope(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  return {
    database: typeof s.database === "boolean" ? s.database : DEFAULT_SCOPE.database,
    assets: typeof s.assets === "boolean" ? s.assets : DEFAULT_SCOPE.assets,
    extensions: typeof s.extensions === "boolean" ? s.extensions : DEFAULT_SCOPE.extensions,
    excludedCollections: Array.isArray(s.excludedCollections) ? s.excludedCollections.filter((v) => typeof v === "string" && COLLECTION_NAME_RE.test(v)) : []
  };
}
async function readConfig() {
  try {
    const raw = await readFile(join(config.backupDir, CONFIG_FILE), "utf8");
    const cfg = JSON.parse(raw);
    const toInt = (v, min, max, def) => {
      const n = Math.floor(Number(v));
      return Number.isFinite(n) && n >= min && n <= max ? n : def;
    };
    return {
      schedule: VALID_SCHEDULES.includes(cfg.schedule) ? cfg.schedule : "off",
      scheduleMinute: toInt(cfg.scheduleMinute, 0, 59, 0),
      scheduleHour: toInt(cfg.scheduleHour, 0, 23, 0),
      retention: VALID_RETENTIONS.includes(cfg.retention) ? cfg.retention : "all",
      quotaMB: Number.isFinite(cfg.quotaMB) && cfg.quotaMB >= 0 ? cfg.quotaMB : 0,
      minFreeMB: Number.isFinite(cfg.minFreeMB) && cfg.minFreeMB >= 0 ? cfg.minFreeMB : 100,
      backupScope: normalizeScope(cfg.backupScope)
    };
  } catch {
    return { ...DEFAULT_CONFIG, backupScope: { ...DEFAULT_SCOPE } };
  }
}
async function writeConfig(cfg) {
  const target = join(config.backupDir, CONFIG_FILE);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(cfg, null, 2)}
`);
  await rename(tmp, target);
}

/**
 * Disk-usage measurement, quota checks, and retention/rotation enforcement.
 *
 * Stateless — paths are derived from {@link config} at call time.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */
async function dirSizeBytes(dir) {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirSizeBytes(full);
    } else if (entry.isFile()) {
      total += (await stat(full)).size;
    }
  }
  return total;
}
function getFreeMB() {
  try {
    const out = execFileSync("df", ["-P", "-m", config.backupDir], { encoding: "utf8" });
    const line = out.trim().split("\n").pop() || "";
    const parts = line.split(/\s+/);
    const n = parseInt(parts[3], 10);
    return Number.isFinite(n) ? n : null;
  } catch (e) {
    console.warn("df failed:", e.message);
    return null;
  }
}
async function checkQuota() {
  const cfg = await readConfig();
  const freeMB = getFreeMB();
  let usedMB = null;
  try {
    usedMB = Math.round(await dirSizeBytes(config.backupDir) / (1024 * 1024));
  } catch (e) {
    console.warn("Backup size check failed:", e.message);
  }
  const reasons = [];
  if (cfg.minFreeMB > 0 && freeMB !== null && freeMB < cfg.minFreeMB) {
    reasons.push({ code: "DISK_FULL", text: `Free space ${freeMB}MB < min ${cfg.minFreeMB}MB`, freeMB, minFreeMB: cfg.minFreeMB });
  }
  if (cfg.quotaMB > 0 && usedMB !== null && usedMB >= cfg.quotaMB) {
    reasons.push({ code: "QUOTA_EXCEEDED", text: `Backup usage ${usedMB}MB >= quota ${cfg.quotaMB}MB`, usedMB, quotaMB: cfg.quotaMB });
  }
  return { ok: reasons.length === 0, reasons, usedMB, freeMB };
}
function uploadBudget(freeMB, minFreeMB) {
  if (freeMB === null) return { ok: true, budgetBytes: null };
  if (freeMB <= minFreeMB) return { ok: false, budgetBytes: 0 };
  return { ok: true, budgetBytes: (freeMB - minFreeMB) * 1024 * 1024 };
}
async function rotateForSpace() {
  const all = await readAllManifests();
  const candidates = all.filter((m) => m.source === "scheduled" && m.status === "success").sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  for (const m of candidates) {
    const id = String(m.id);
    if (!BACKUP_ID_RE.test(id)) continue;
    const dir = join(config.backupDir, id);
    const locked = await acquireLock(id, { backupId: id, startedAt: (/* @__PURE__ */ new Date()).toISOString(), operation: "delete" });
    if (!locked) {
      console.log(`Quota rotation: skip ${id} (in use)`);
      continue;
    }
    let deleted = false;
    try {
      await rm(dir, { recursive: true });
      deleted = true;
      console.log(`Quota rotation: deleted ${id}`);
    } catch (e) {
      console.warn(`Quota rotation: failed to delete ${id}:`, e.message);
    } finally {
      await releaseLock(id);
    }
    if (deleted) {
      const recheck = await checkQuota();
      if (recheck.ok) return true;
    }
  }
  return false;
}
async function enforceRetention() {
  const cfg = await readConfig();
  if (cfg.retention === "all") return;
  const all = await readAllManifests();
  const scheduled = all.filter((m) => m.source === "scheduled" && m.status === "success").sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  if (scheduled.length === 0) return;
  let toDelete = [];
  if (cfg.retention.startsWith("last-")) {
    const keep = parseInt(cfg.retention.split("-")[1], 10);
    toDelete = scheduled.slice(keep);
  } else if (cfg.retention.startsWith("days-")) {
    const days = parseInt(cfg.retention.split("-")[1], 10);
    const cutoff = new Date(Date.now() - days * 864e5).toISOString();
    toDelete = scheduled.filter((m) => String(m.createdAt || "") < cutoff);
  }
  let removed = 0;
  for (const m of toDelete) {
    const id = String(m.id);
    if (!BACKUP_ID_RE.test(id)) continue;
    const dir = join(config.backupDir, id);
    const locked = await acquireLock(id, { backupId: id, startedAt: (/* @__PURE__ */ new Date()).toISOString(), operation: "delete" });
    if (!locked) {
      console.log(`Retention: skip ${id} (in use)`);
      continue;
    }
    try {
      await rm(dir, { recursive: true });
      removed += 1;
      console.log(`Retention: deleted ${id}`);
    } catch (e) {
      console.warn(`Retention: failed to delete ${id}:`, e.message);
    } finally {
      await releaseLock(id);
    }
  }
  if (removed > 0) {
    console.log(`Retention: removed ${removed} old scheduled backup(s)`);
  }
}

/**
 * Live backup execution. Backups run exactly as in the sidecar: `backup.sh` is
 * spawned as a child process and {@link monitorProcess} finalises the manifest
 * on exit, enforcing retention (scheduled) or notifying admins on failure.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */
async function removeFailedBackupDir(dir, backupId) {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (e) {
    getRuntime().logger?.warn?.(`Could not remove failed backup directory ${backupId}: ${e.message}`);
  }
}
function monitorProcess(runnerPromise, backupId, source) {
  const dir = join(config.backupDir, backupId);
  runnerPromise.then(async ({ exitCode: code }) => {
    getRuntime().logger?.info?.(`Runner exited: ${backupId} code=${code}`);
    const finishedAt = (/* @__PURE__ */ new Date()).toISOString();
    const cancelled = cancelledIds.has(backupId);
    cancelledIds.delete(backupId);
    if (cancelled) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch (e) {
        getRuntime().logger?.warn?.(`Could not remove cancelled backup directory ${backupId}: ${e.message}`);
      }
      await releaseLock(LIVE_DB);
      appendActivity({ action: "backup_cancelled", backupId, source }).catch(() => {
      });
      return;
    }
    const manifest = await readManifest(dir) || {
      id: backupId,
      createdAt: finishedAt,
      label: backupId.split("__")[2] || "unknown",
      source: source || "manual",
      status: "running",
      tool: { name: config.dbAdapter }
    };
    manifest.status = code === 0 ? "success" : "failed";
    manifest.finishedAt = finishedAt;
    if (code !== 0) {
      let errDetail = "";
      try {
        const log = (await readFile(join(dir, "runner.log"), "utf8")).trim();
        errDetail = log.split("\n").slice(-20).join("\n");
      } catch {
      }
      manifest.error = errDetail || `Runner exited with code ${code}`;
      await writeManifest(dir, manifest);
      await removeFailedBackupDir(dir, backupId);
      await releaseLock(LIVE_DB);
      appendActivity({ action: "backup_failed", backupId, source, detail: String(manifest.error) }).catch(() => {
      });
      if (source === "scheduled") {
        notifyAdmins(`Scheduled backup failed: ${backupId}`, String(manifest.error || `Runner exited with code ${code}`)).catch(() => {
        });
      }
      return;
    }
    delete manifest.error;
    try {
      manifest.sizeBytes = await dirSizeBytes(dir);
    } catch (e) {
      getRuntime().logger?.warn?.(`Could not calculate size for ${backupId}: ${e.message}`);
    }
    try {
      const { collections, ...verify } = await parseVerifyData(dir);
      manifest.verify = verify;
      if (manifest.scope && Array.isArray(collections)) {
        manifest.scope.collections = collections;
      }
    } catch (e) {
      getRuntime().logger?.warn?.(`Could not read verify data for ${backupId}: ${e.message}`);
    }
    await writeManifest(dir, manifest);
    await releaseLock(LIVE_DB);
    appendActivity({
      action: code === 0 ? "backup_success" : "backup_failed",
      backupId,
      source,
      detail: code === 0 ? void 0 : String(manifest.error)
    }).catch(() => {
    });
    if (source === "scheduled") {
      try {
        await enforceRetention();
      } catch (e) {
        getRuntime().logger?.warn?.(`Retention enforcement failed: ${e.message}`);
      }
    }
  }).catch(async (err) => {
    getRuntime().logger?.error?.(`Monitor error for ${backupId}: ${err.message}`);
    try {
      const m = await readManifest(dir);
      if (m && m.status === "running") {
        m.status = "failed";
        m.error = `Backup monitor failed to persist result: ${err.message}`;
        m.finishedAt = (/* @__PURE__ */ new Date()).toISOString();
        await writeManifest(dir, m);
      }
      await releaseLock(LIVE_DB);
    } catch (e2) {
      getRuntime().logger?.error?.(`Could not finalize manifest after monitor error for ${backupId} \u2014 keeping LIVE_DB lock as recovery anchor: ${e2.message}`);
    }
  });
}
async function startBackup(backupId, source, scopeOverride) {
  const sanity = await getSanityReport();
  if (!sanity.operational) {
    return {
      ok: false,
      status: 503,
      error: installationError(sanity),
      code: "INSTALL_INCOMPLETE"
    };
  }
  const backupPath = resolve(config.backupDir, backupId);
  let quota = await checkQuota();
  if (!quota.ok) {
    if (source === "scheduled") {
      getRuntime().logger?.warn?.(`Quota exceeded before scheduled backup, rotating: ${quota.reasons.map((r) => r.text).join("; ")}`);
      const freed = await rotateForSpace();
      if (freed) quota = await checkQuota();
    }
    if (!quota.ok) {
      const msg = quota.reasons.map((r) => r.text).join("; ");
      appendActivity({ action: "backup_failed", backupId, source, detail: `Quota: ${msg}` }).catch(() => {
      });
      if (source === "scheduled") {
        notifyAdmins("Scheduled backup skipped: storage limit reached", msg).catch(() => {
        });
      }
      return { ok: false, status: 507, error: msg };
    }
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const label = backupId.split("__")[2] || "manual";
  const locked = await acquireLock(LIVE_DB, { backupId, startedAt: now, source, operation: "backup" });
  if (!locked) {
    appendActivity({ action: "backup_failed", backupId, source, detail: "Another backup or restore is already running" }).catch(() => {
    });
    return { ok: false, status: 409, error: "Another backup or restore is already running" };
  }
  const [directusVersion, cfg] = await Promise.all([fetchDirectusVersion(), readConfig()]);
  const scope = scopeOverride || cfg.backupScope;
  const scopeEnv = buildScopeEnv("backup", scope);
  const includedCollections = scope.includeCollections || [];
  const manifest = {
    id: backupId,
    createdAt: now,
    label,
    source,
    status: "running",
    tool: { name: config.dbAdapter },
    scope: {
      database: scope.database,
      assets: scope.assets,
      extensions: scope.extensions,
      ...scope.excludedCollections && scope.excludedCollections.length > 0 ? { excludedCollections: [...scope.excludedCollections] } : { includedCollections: [...includedCollections] }
    },
    ...directusVersion ? { directusVersion } : {}
  };
  const pathExists = await access(backupPath).then(() => true).catch(() => false);
  if (pathExists) {
    await releaseLock(LIVE_DB);
    appendActivity({ action: "backup_failed", backupId, source, detail: "Backup directory already exists" }).catch(() => {
    });
    return { ok: false, status: 409, error: `Backup directory already exists: ${backupId}` };
  }
  const logPath = join(backupPath, "runner.log");
  let runnerPromise;
  try {
    await writeManifest(backupPath, manifest);
    const command = await resolveScriptsDir().then((d) => join(d, "backup.sh"));
    const env = buildRunnerEnv(backupId, backupPath, scopeEnv);
    runnerPromise = spawnRunner(env, logPath, { command });
  } catch (e) {
    const errMsg = e.message || String(e);
    getRuntime().logger?.error?.(`Failed to start backup: ${errMsg}`);
    manifest.status = "failed";
    manifest.error = `Failed to start backup: ${errMsg}`;
    manifest.finishedAt = (/* @__PURE__ */ new Date()).toISOString();
    try {
      await writeManifest(backupPath, manifest);
    } catch (writeErr) {
      getRuntime().logger?.error?.(`Could not persist failed-status manifest: ${writeErr.message}`);
    }
    await removeFailedBackupDir(backupPath, backupId);
    await releaseLock(LIVE_DB);
    appendActivity({ action: "backup_failed", backupId, source, detail: String(manifest.error) }).catch(() => {
    });
    if (source === "scheduled") {
      notifyAdmins(`Scheduled backup failed: ${backupId}`, String(manifest.error)).catch(() => {
      });
    }
    return { ok: false, status: 503, error: `Failed to start backup: ${errMsg}` };
  }
  monitorProcess(runnerPromise, backupId, source);
  return { ok: true, status: 202, backupId };
}

/**
 * Request-input validation and backup-ID generation: traversal-safe ID checks,
 * scope-payload validation, and the timestamped ID format.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */
function pad(n) {
  return String(n).padStart(2, "0");
}
function generateBackupId(label) {
  const d = /* @__PURE__ */ new Date();
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  return `${date}__${time}__${label}`;
}
function validateBackupId(backupId, res) {
  if (!backupId || !BACKUP_ID_RE.test(backupId)) {
    res.status(400).json({ error: "Invalid backupId" });
    return false;
  }
  const backupPath = resolve(config.backupDir, backupId);
  if (!backupPath.startsWith(`${resolve(config.backupDir)}/`)) {
    res.status(400).json({ error: "Invalid backupId" });
    return false;
  }
  return true;
}
function validateScopeInput(input) {
  if (!input || typeof input !== "object") return { ok: false, error: "scope must be an object" };
  const s = input;
  const out = {};
  if (s.database !== void 0) {
    if (typeof s.database !== "boolean") return { ok: false, error: "scope.database must be a boolean" };
    out.database = s.database;
  }
  if (s.assets !== void 0) {
    if (typeof s.assets !== "boolean") return { ok: false, error: "scope.assets must be a boolean" };
    out.assets = s.assets;
  }
  if (s.extensions !== void 0) {
    if (typeof s.extensions !== "boolean") return { ok: false, error: "scope.extensions must be a boolean" };
    out.extensions = s.extensions;
  }
  if (s.includeCollections !== void 0) {
    if (!Array.isArray(s.includeCollections) || s.includeCollections.some((v) => typeof v !== "string")) {
      return { ok: false, error: "scope.includeCollections must be an array of strings" };
    }
    if (s.includeCollections.some((v) => !COLLECTION_NAME_RE.test(v))) {
      return { ok: false, error: "scope.includeCollections contains an invalid collection name" };
    }
    out.includeCollections = s.includeCollections;
  }
  if (s.excludedCollections !== void 0) {
    if (!Array.isArray(s.excludedCollections) || s.excludedCollections.some((v) => typeof v !== "string")) {
      return { ok: false, error: "scope.excludedCollections must be an array of strings" };
    }
    if (s.excludedCollections.some((v) => !COLLECTION_NAME_RE.test(v))) {
      return { ok: false, error: "scope.excludedCollections contains an invalid collection name" };
    }
    out.excludedCollections = s.excludedCollections;
  }
  return { ok: true, value: out };
}
function isEmptyComponentScope(scope) {
  return !scope.database && !scope.assets && !scope.extensions;
}

/**
 * Cron scheduling for automatic backups, plus the cluster-instance guard that
 * keeps the scheduler and startup recovery on a single worker.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */
let cronTask = null;
async function applySchedule(logger) {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }
  const cfg = await readConfig();
  const expr = buildCronExpr(cfg.schedule, cfg.scheduleMinute, cfg.scheduleHour);
  if (!expr) {
    logger?.info?.("Backup schedule: off");
    return;
  }
  cronTask = cron.schedule(expr, async () => {
    logger?.info?.("Cron triggered: starting scheduled backup");
    const id = generateBackupId("scheduled");
    const result = await startBackup(id, "scheduled");
    if (!result.ok) {
      logger?.warn?.(`Scheduled backup failed to start: ${result.error}`);
      appendActivity({ action: "backup_failed", backupId: id, source: "scheduled", detail: result.error }).catch(() => {
      });
    }
  });
  logger?.info?.(`Backup schedule: ${cfg.schedule} (${expr})`);
}
function isSchedulerInstance() {
  const inst = process.env.NODE_APP_INSTANCE;
  return inst === void 0 || inst === "0";
}

/**
 * Request authorization: Directus admins pass; everyone else is checked against
 * the "Backup Access" policy.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */
async function requireBackupAccess(req, res, database) {
  const acc = req.accountability;
  if (acc?.admin) return true;
  const userId = acc?.user ?? null;
  const roles = acc?.roles ?? [];
  if (!userId && roles.length === 0) {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }
  const query = database("directus_access").join("directus_policies", "directus_access.policy", "directus_policies.id").where("directus_policies.name", BACKUP_POLICY_NAME).andWhere(function() {
    if (roles.length > 0) this.whereIn("directus_access.role", roles);
    if (userId) this.orWhere("directus_access.user", userId);
  }).first();
  if (!await query) {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }
  return true;
}

/**
 * Backup import: accepts an uploaded `.tar.gz`, validates archive integrity
 * (symlinks, device files, path traversal), bounds disk usage, extracts, and
 * verifies the manifest before accepting. Never touches the live database.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */
const TMP_PREFIX = UPLOAD_TMP_PREFIX;
function tarList(archivePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn("tar", ["tvzf", archivePath]);
    let out = "";
    proc.stdout.on("data", (c) => {
      out += c.toString();
    });
    proc.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(`Cannot list archive (code=${code})`)));
    proc.on("error", reject);
  });
}
function validateTarListing(listing) {
  for (const entry of listing.trim().split("\n").filter(Boolean)) {
    const parts = entry.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const permissions = parts[0];
    const rawFilename = parts.slice(5).join(" ");
    const filename = rawFilename.split(" -> ")[0];
    if (permissions[0] === "l") return "Archive contains symlinks (security risk)";
    if (permissions[0] === "h") return "Archive contains hard links (security risk)";
    if (rawFilename.includes(" -> ")) return "Archive contains hard links (security risk)";
    if ("bcps".includes(permissions[0])) return "Archive contains device files, pipes, or sockets (security risk)";
    if (filename.startsWith("/") || filename.includes("..")) return "Archive contains unsafe paths";
  }
  return null;
}
async function handleImport(req, res) {
  if (!config.importEnabled) {
    res.status(403).json({ error: "Backup import is disabled", code: "IMPORT_DISABLED" });
    return;
  }
  const sanity = await getSanityReport();
  if (!sanity.operational) {
    res.status(503).json({
      error: installationError(sanity),
      code: "INSTALL_INCOMPLETE",
      issues: sanity.issues.filter((i) => i.severity === "error")
    });
    return;
  }
  const tmpFile = join(config.backupDir, `${TMP_PREFIX}${Date.now()}.tar.gz`);
  let extractedId = null;
  let lockedId = null;
  try {
    const cfg = await readConfig();
    const freeMB = getFreeMB();
    const { ok: spaceOk, budgetBytes: rawBudget } = uploadBudget(freeMB, cfg.minFreeMB);
    if (!spaceOk) {
      res.status(507).json({ error: `Storage limit reached: free space ${freeMB}MB <= min ${cfg.minFreeMB}MB`, code: "DISK_FULL", freeMB, minFreeMB: cfg.minFreeMB });
      return;
    }
    let budgetBytes = rawBudget;
    if (budgetBytes === null && cfg.quotaMB > 0) {
      try {
        const usedMB = Math.round(await dirSizeBytes(config.backupDir) / (1024 * 1024));
        const remainingMB = cfg.quotaMB - usedMB;
        if (remainingMB <= 0) {
          res.status(507).json({ error: `Quota already reached: used ${usedMB}MB >= quota ${cfg.quotaMB}MB`, code: "QUOTA_EXCEEDED", usedMB, quotaMB: cfg.quotaMB });
          return;
        }
        budgetBytes = remainingMB * 1024 * 1024;
      } catch {
      }
    }
    await new Promise((resolve, reject) => {
      const ws = createWriteStream(tmpFile);
      let written = 0;
      let aborted = false;
      ws.on("error", reject);
      ws.on("finish", () => resolve());
      req.on("data", (chunk) => {
        if (aborted) return;
        written += chunk.length;
        if (budgetBytes !== null && written > budgetBytes) {
          aborted = true;
          req.unpipe(ws);
          ws.destroy();
          if (!res.headersSent) res.status(507).json({ error: "Upload exceeds available storage" });
          req.destroy();
          reject(new Error("Upload exceeds available storage"));
        }
      });
      req.pipe(ws);
    });
    const tmpStat = await stat(tmpFile);
    if (tmpStat.size === 0) {
      res.status(400).json({ error: "Empty upload" });
      return;
    }
    const listing = await new Promise((resolve, reject) => {
      const proc = spawn("tar", ["tvzf", tmpFile]);
      let out = "";
      proc.stdout.on("data", (c) => {
        out += c.toString();
      });
      proc.on("close", (code) => code === 0 ? resolve(out) : reject(new Error("Invalid or corrupted archive")));
      proc.on("error", reject);
    });
    const entries = listing.trim().split("\n").filter(Boolean);
    if (entries.length === 0) {
      res.status(400).json({ error: "Archive is empty" });
      return;
    }
    const topLevelDirs = /* @__PURE__ */ new Set();
    let extractedBytes = 0;
    for (const entry of entries) {
      const parts = entry.trim().split(/\s+/);
      if (parts.length < 6) continue;
      const permissions = parts[0];
      const rawFilename = parts.slice(5).join(" ");
      const filename = rawFilename.split(" -> ")[0];
      if (permissions[0] === "l") {
        res.status(400).json({ error: "Archive contains symlinks (security risk)" });
        return;
      }
      if (permissions[0] === "h") {
        res.status(400).json({ error: "Archive contains hard links (security risk)" });
        return;
      }
      if (rawFilename.includes(" -> ")) {
        res.status(400).json({ error: "Archive contains hard links (security risk)" });
        return;
      }
      if ("bcps".includes(permissions[0])) {
        res.status(400).json({ error: "Archive contains device files, pipes, or sockets (security risk)" });
        return;
      }
      if (filename.startsWith("/") || filename.includes("..")) {
        res.status(400).json({ error: "Archive contains unsafe paths" });
        return;
      }
      const size = Number.parseInt(parts[2], 10);
      if (Number.isFinite(size)) extractedBytes += size;
      const top = filename.split("/")[0];
      if (top) topLevelDirs.add(top);
    }
    if (topLevelDirs.size !== 1) {
      res.status(400).json({ error: "Archive must contain exactly one backup directory" });
      return;
    }
    const extractBudget = uploadBudget(getFreeMB(), cfg.minFreeMB);
    if (!extractBudget.ok) {
      res.status(507).json({ error: "Storage limit reached before extraction" });
      return;
    }
    if (extractBudget.budgetBytes !== null && extractedBytes > extractBudget.budgetBytes) {
      res.status(507).json({ error: `Extracted size ~${Math.round(extractedBytes / (1024 * 1024))}MB exceeds available storage` });
      return;
    }
    if (cfg.quotaMB > 0) {
      let currentUsedMB = null;
      try {
        currentUsedMB = Math.round(await dirSizeBytes(config.backupDir) / (1024 * 1024));
      } catch {
      }
      if (currentUsedMB !== null) {
        const importMB = Math.round(extractedBytes / (1024 * 1024));
        if (currentUsedMB + importMB > cfg.quotaMB) {
          res.status(507).json({
            error: `Quota would be exceeded: current ${currentUsedMB}MB + import ~${importMB}MB > quota ${cfg.quotaMB}MB`,
            code: "QUOTA_IMPORT_EXCEEDED",
            usedMB: currentUsedMB,
            importMB,
            quotaMB: cfg.quotaMB
          });
          return;
        }
      }
    }
    const backupId = [...topLevelDirs][0];
    if (!BACKUP_ID_RE.test(backupId)) {
      res.status(400).json({ error: "Archive directory name is not a valid backup ID" });
      return;
    }
    const targetDir = resolve(config.backupDir, backupId);
    if (!targetDir.startsWith(`${resolve(config.backupDir)}/`)) {
      res.status(400).json({ error: "Invalid backup ID in archive" });
      return;
    }
    if (!await acquireLock(backupId, { backupId, startedAt: (/* @__PURE__ */ new Date()).toISOString(), operation: "import" })) {
      res.status(409).json({ error: "Backup is in use by an active operation" });
      return;
    }
    lockedId = backupId;
    try {
      await stat(targetDir);
      res.status(409).json({ error: `Backup ${backupId} already exists` });
      return;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    extractedId = backupId;
    await new Promise((resolve, reject) => {
      const proc = spawn("tar", ["xzf", tmpFile, "-C", config.backupDir, "-o", "--no-same-permissions", "-h"]);
      proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`tar extract failed (code=${code})`)));
      proc.on("error", reject);
    });
    try {
      await rm(tmpFile, { force: true });
    } catch {
    }
    const manifest = await readManifest(targetDir);
    const rejectExtracted = async (status, body) => {
      try {
        await rm(targetDir, { recursive: true, force: true });
      } catch {
      }
      extractedId = null;
      res.status(status).json(body);
    };
    if (!manifest) return rejectExtracted(400, { error: "Archive does not contain a valid backup manifest" });
    if (manifest.id !== backupId) return rejectExtracted(400, { error: "Archive manifest id does not match the archive directory name" });
    if (manifest.status !== "success") return rejectExtracted(409, { error: `Backup has status "${String(manifest.status)}", only successful backups can be imported` });
    const scope = manifest.scope || {};
    if (scope.includedCollections !== void 0) {
      const list = scope.includedCollections;
      if (!Array.isArray(list) || list.some((v) => typeof v !== "string" || !COLLECTION_NAME_RE.test(v))) {
        return rejectExtracted(400, { error: "Archive manifest contains an invalid collection name in scope.includedCollections" });
      }
    }
    const requiredFiles = [
      [scope.database !== false, "database.dump"],
      [scope.assets !== false, "uploads.tar.gz"],
      [scope.extensions !== false, "extensions.tar.gz"]
    ];
    for (const [included, file] of requiredFiles) {
      if (!included) continue;
      const innerPath = join(targetDir, file);
      try {
        await stat(innerPath);
      } catch {
        return rejectExtracted(400, { error: `Archive manifest declares a component the archive does not contain: ${file} is missing` });
      }
      if (file.endsWith(".tar.gz")) {
        try {
          const innerErr = validateTarListing(await tarList(innerPath));
          if (innerErr) return rejectExtracted(400, { error: `${file} failed security validation: ${innerErr}` });
        } catch {
          return rejectExtracted(400, { error: `${file} could not be read or decompressed` });
        }
      }
    }
    const quota = await checkQuota();
    if (!quota.ok) {
      const first = quota.reasons[0];
      return rejectExtracted(507, { ...first, error: quota.reasons.map((r) => r.text).join("; ") });
    }
    extractedId = null;
    appendActivity({ action: "upload", backupId }).catch(() => {
    });
    res.status(200).json(manifest);
  } catch (e) {
    const msg = e.message || "Upload failed";
    if (!res.headersSent) res.status(400).json({ error: msg });
  } finally {
    try {
      await rm(tmpFile, { force: true });
    } catch {
    }
    if (extractedId) {
      const dir = resolve(config.backupDir, extractedId);
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
      }
    }
    if (lockedId) await releaseLock(lockedId);
  }
}

/**
 * Backup download: streams a backup directory as a `.tar.gz`, holding the
 * per-backup lock for the duration of the stream.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */
async function handleDownload(id, res, logger) {
  if (!config.exportEnabled) {
    res.status(403).json({ error: "Backup export is disabled", code: "EXPORT_DISABLED" });
    return;
  }
  const dir = resolve(config.backupDir, id);
  const manifest = await readManifest(dir);
  if (!manifest) {
    res.status(404).json({ error: "Backup not found" });
    return;
  }
  if (manifest.status === "running") {
    res.status(409).json({ error: "Cannot download running backup" });
    return;
  }
  const locked = await acquireLock(id, { backupId: id, startedAt: (/* @__PURE__ */ new Date()).toISOString(), operation: "download" });
  if (!locked) {
    res.status(409).json({ error: "Backup is in use by an active operation" });
    return;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseLock(id).catch((e) => logger?.warn?.(`Download lock release failed for ${id}: ${e.message}`));
  };
  const tar = spawn("tar", ["czf", "-", "-C", config.backupDir, id], { stdio: ["ignore", "pipe", "pipe"] });
  let downloadStarted = false;
  const sendHeaders = () => {
    if (res.headersSent) return;
    downloadStarted = true;
    res.writeHead(200, {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${id}.tar.gz"`
    });
  };
  tar.stdout.on("data", (chunk) => {
    sendHeaders();
    if (!res.write(chunk)) tar.stdout.pause();
  });
  res.on("drain", () => tar.stdout.resume());
  tar.stderr.on("data", (c) => logger?.error?.(`tar stderr: ${c.toString()}`));
  tar.on("error", (e) => {
    release();
    if (!res.headersSent) res.status(500).json({ error: "Archive failed" });
    else if (downloadStarted) {
      logger?.error?.(`Archive failed after response started: ${e.message}`);
      res.destroy();
    }
  });
  tar.on("close", (code) => {
    release();
    if (code !== 0 && !res.headersSent) res.status(500).json({ error: "Archive failed" });
    else if (code !== 0 && downloadStarted) {
      logger?.error?.(`Archive failed after response started (exit ${code})`);
      res.destroy();
    } else {
      sendHeaders();
      res.end();
    }
  });
  res.on("close", () => {
    if (tar.exitCode === null && !tar.killed) tar.kill();
    release();
  });
}

/**
 * Route wiring for the backup API. Every verb is wrapped once so an async
 * handler that rejects returns a clean 500 instead of hanging the client; each
 * route authenticates via {@link requireBackupAccess} before doing any work.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */
function registerRoutes(router, context) {
  const { database, logger } = context;
  const auth = (req, res) => requireBackupAccess(req, res, database);
  for (const verb of ["get", "post", "put", "delete"]) {
    const original = router[verb].bind(router);
    router[verb] = (path, h) => original(path, (req, res) => Promise.resolve(h(req, res)).catch((err) => {
      logger?.error?.(`Unhandled error in ${req.method} ${path}: ${err.message}`);
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    }));
  }
  router.get("/list", async (req, res) => {
    if (!await auth(req, res)) return;
    const manifests = await readAllManifests();
    manifests.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    res.status(200).json(manifests);
  });
  router.post("/create", async (req, res) => {
    if (!await auth(req, res)) return;
    const body = req.body ?? {};
    const rawLabel = body.label ?? "";
    const label = typeof rawLabel === "string" && rawLabel.length > 0 && LABEL_RE.test(rawLabel) && rawLabel.length <= LABEL_MAX ? rawLabel : "manual";
    let scopeOverride;
    if (body.scope !== void 0) {
      const r = validateScopeInput(body.scope);
      if (!r.ok) {
        res.status(400).json({ error: `scope: ${r.error}` });
        return;
      }
      scopeOverride = { ...DEFAULT_SCOPE, ...r.value };
      if (isEmptyComponentScope(scopeOverride)) {
        res.status(400).json({ error: "scope must include at least one component (database, assets, or extensions)" });
        return;
      }
    }
    const backupId = generateBackupId(label);
    const result = await startBackup(backupId, "manual", scopeOverride);
    if (result.ok) {
      res.status(202).json({ id: backupId, startedAt: (/* @__PURE__ */ new Date()).toISOString() });
    } else {
      res.status(result.status).json({ error: result.error, code: result.code });
    }
  });
  router.post("/upload", async (req, res) => {
    if (!await auth(req, res)) return;
    await handleImport(req, res);
  });
  router.post("/:id/restore", async (req, res) => {
    if (!await auth(req, res)) return;
    const { id } = req.params;
    if (!validateBackupId(id, res)) return;
    let requestScope;
    const scope = req.body?.scope;
    if (scope !== void 0) {
      const r = validateScopeInput(scope);
      if (!r.ok) {
        res.status(400).json({ error: `scope: ${r.error}` });
        return;
      }
      requestScope = {
        database: typeof r.value.database === "boolean" ? r.value.database : DEFAULT_SCOPE.database,
        assets: typeof r.value.assets === "boolean" ? r.value.assets : DEFAULT_SCOPE.assets,
        extensions: typeof r.value.extensions === "boolean" ? r.value.extensions : DEFAULT_SCOPE.extensions,
        includeCollections: r.value.includeCollections || []
      };
      if (isEmptyComponentScope(requestScope)) {
        res.status(400).json({ error: "scope must include at least one component (database, assets, or extensions)" });
        return;
      }
    }
    const backupPath = resolve(config.backupDir, id);
    const manifest = await readManifest(backupPath);
    if (!manifest) {
      res.status(404).json({ error: "Backup not found" });
      return;
    }
    if (manifest.status !== "success") {
      res.status(409).json({ error: "Backup not in success state" });
      return;
    }
    const result = await requestRestore(id, manifest, backupPath, requestScope);
    if (result.ok) {
      res.status(202).json({ accepted: true, backupId: id });
      scheduleContainerRestart(id);
    } else {
      res.status(result.status).json({ error: result.error, code: result.code });
    }
  });
  router.post("/:id/cancel", async (req, res) => {
    if (!await auth(req, res)) return;
    const { id } = req.params;
    if (!validateBackupId(id, res)) return;
    const manifest = await readManifest(resolve(config.backupDir, id));
    if (!manifest) {
      res.status(404).json({ error: "Backup not found" });
      return;
    }
    if (manifest.status !== "running") {
      res.status(409).json({ error: "Backup is not running" });
      return;
    }
    if (!cancelBackup(id)) {
      res.status(409).json({ error: "Backup process not found \u2014 may have just finished" });
      return;
    }
    res.status(202).json({ accepted: true, backupId: id });
  });
  router.get("/:id/download", async (req, res) => {
    if (!await auth(req, res)) return;
    const { id } = req.params;
    if (!validateBackupId(id, res)) return;
    await handleDownload(id, res, logger);
  });
  router.delete("/:id", async (req, res) => {
    if (!await auth(req, res)) return;
    const { id } = req.params;
    if (!validateBackupId(id, res)) return;
    const dir = resolve(config.backupDir, id);
    const manifest = await readManifest(dir);
    if (!manifest) {
      res.status(404).json({ error: "Backup not found" });
      return;
    }
    if (manifest.status === "running") {
      res.status(409).json({ error: "Cannot delete running backup" });
      return;
    }
    const locked = await acquireLock(id, { backupId: id, startedAt: (/* @__PURE__ */ new Date()).toISOString(), operation: "delete" });
    if (!locked) {
      res.status(409).json({ error: "Backup is in use by an active operation" });
      return;
    }
    try {
      await rm(dir, { recursive: true });
    } catch (e) {
      if (e.code === "ENOENT") {
        res.status(404).json({ error: "Backup not found" });
        return;
      }
      throw e;
    } finally {
      await releaseLock(id);
    }
    appendActivity({ action: "delete", backupId: id }).catch(() => {
    });
    res.status(200).json({ success: true });
  });
  router.get("/config", async (req, res) => {
    if (!await auth(req, res)) return;
    res.status(200).json({ ...await readConfig(), importEnabled: config.importEnabled, exportEnabled: config.exportEnabled });
  });
  router.put("/config", async (req, res) => {
    if (!await auth(req, res)) return;
    const body = req.body ?? {};
    const cfg = await readConfig();
    if (body.schedule !== void 0) {
      if (!VALID_SCHEDULES.includes(body.schedule)) {
        res.status(400).json({ error: `Invalid schedule. Valid: ${VALID_SCHEDULES.join(", ")}` });
        return;
      }
      cfg.schedule = body.schedule;
    }
    if (body.scheduleMinute !== void 0) {
      const v = Math.floor(Number(body.scheduleMinute));
      if (!Number.isFinite(v) || v < 0 || v > 59) {
        res.status(400).json({ error: "scheduleMinute must be 0\u201359" });
        return;
      }
      cfg.scheduleMinute = v;
    }
    if (body.scheduleHour !== void 0) {
      const v = Math.floor(Number(body.scheduleHour));
      if (!Number.isFinite(v) || v < 0 || v > 23) {
        res.status(400).json({ error: "scheduleHour must be 0\u201323" });
        return;
      }
      cfg.scheduleHour = v;
    }
    if (body.retention !== void 0) {
      if (!VALID_RETENTIONS.includes(body.retention)) {
        res.status(400).json({ error: `Invalid retention. Valid: ${VALID_RETENTIONS.join(", ")}` });
        return;
      }
      cfg.retention = body.retention;
    }
    if (body.quotaMB !== void 0) {
      const v = Number(body.quotaMB);
      if (!Number.isFinite(v) || v < 0) {
        res.status(400).json({ error: "quotaMB must be >= 0" });
        return;
      }
      cfg.quotaMB = v;
    }
    if (body.minFreeMB !== void 0) {
      const v = Number(body.minFreeMB);
      if (!Number.isFinite(v) || v < 0) {
        res.status(400).json({ error: "minFreeMB must be >= 0" });
        return;
      }
      cfg.minFreeMB = v;
    }
    if (body.backupScope !== void 0) {
      const r = validateScopeInput(body.backupScope);
      if (!r.ok) {
        res.status(400).json({ error: `backupScope: ${r.error}` });
        return;
      }
      const merged = { ...cfg.backupScope || { ...DEFAULT_SCOPE }, ...r.value };
      if (isEmptyComponentScope(merged)) {
        res.status(400).json({ error: "backupScope must include at least one component (database, assets, or extensions)" });
        return;
      }
      cfg.backupScope = merged;
    }
    await writeConfig(cfg);
    if (isSchedulerInstance()) await applySchedule(logger);
    appendActivity({ action: "config" }).catch(() => {
    });
    res.status(200).json(cfg);
  });
  router.get("/storage", async (req, res) => {
    if (!await auth(req, res)) return;
    const cfg = await readConfig();
    const freeMB = getFreeMB();
    let usedMB = null;
    try {
      usedMB = Math.round(await dirSizeBytes(config.backupDir) / (1024 * 1024));
    } catch (e) {
      logger?.warn?.(`Backup size check failed: ${e.message}`);
    }
    res.status(200).json({ usedMB, freeMB, quotaMB: cfg.quotaMB, minFreeMB: cfg.minFreeMB });
  });
  router.get("/activity", async (req, res) => {
    if (!await auth(req, res)) return;
    const limit = parseInt(req.query?.limit || "100", 10);
    res.status(200).json(await readActivity(Math.min(Math.max(limit, 1), 100)));
  });
  router.get("/check-access", async (req, res) => {
    if (await auth(req, res)) res.json({ access: true });
  });
  router.get("/health", async (req, res) => {
    if (!await auth(req, res)) return;
    res.status(200).json(await getSanityReport());
  });
}

/**
 * Backup API endpoint — self-contained (no sidecar, no Docker socket).
 *
 * This module is the Directus endpoint entry: it initialises config + runtime,
 * runs the one-time startup recovery on the cluster primary, and mounts the
 * routes defined in {@link file://./http/routes.ts}. Every route authenticates
 * via Directus accountability. Backups spawn `backup.sh`; restores are armed in
 * {@link file://./restore/restore.ts} and executed by `restore.sh` after a
 * container restart.
 * @author  Frank Kudermann – alphanull
 * @version 0.10.2
 * @license AGPL-3.0-only
 */
let startupDone = false;
async function runStartup(logger) {
  if (startupDone) return;
  startupDone = true;
  try {
    const sanity = await getSanityReport(true);
    if (!sanity.ok) {
      const summary = sanity.issues.filter((i) => i.severity === "error").map((i) => i.message).join("; ");
      logger?.warn?.(`Backup installation incomplete: ${summary}`);
    }
    await finalizePendingRestore();
    await recoverStaleLocks();
    await cleanStaleTmpFiles();
    await reconcileRunningManifests();
    await applySchedule(logger);
  } catch (e) {
    logger?.error?.(`Backup startup sequence failed: ${e.message}`);
  }
}
function handler(router, context) {
  const { database, getSchema, services, logger } = context;
  initConfig({ ...process.env, ...context.env });
  setRuntime({ getSchema, services, database, logger });
  if (isSchedulerInstance()) {
    runStartup(logger).catch((e) => logger?.error?.(`Backup startup error: ${e.message}`));
  }
  registerRoutes(router, context);
}
var e0 = {
  id: "backup-api",
  handler
};

const hooks = [];const endpoints = [{name:'backup-api',config:e0}];const operations = [];

export { endpoints, hooks, operations };

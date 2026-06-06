import { request } from 'http';

/**
 * Constants for the Backup extension — regex patterns, file names, limits.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */
const BACKUP_ID_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}__[0-9]{2}-[0-9]{2}-[0-9]{2}__[a-zA-Z0-9_-]+$/;
const LABEL_RE = /^[a-zA-Z0-9_-]+$/;
const LABEL_MAX = 32;
const BACKUP_POLICY_NAME = "Backup Access";

/**
 * Path validation utilities — backup ID validation and traversal-safe resolution.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */
function isValidBackupId(id) {
  return typeof id === "string" && BACKUP_ID_RE.test(id);
}

/**
 * Backup API endpoint — auth proxy to the sidecar.
 * Every route authenticates the request via Directus accountability,
 * then forwards to the sidecar. No filesystem operations here.
 * @author  Frank Kudermann – alphanull
 * @version 0.9.0
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
function pad(n) {
  return String(n).padStart(2, "0");
}
function generateBackupId(label) {
  const d = /* @__PURE__ */ new Date();
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  return `${date}__${time}__${label}`;
}
function callSidecar(baseUrl, secret, method, path, payload) {
  return new Promise((resolve) => {
    const url = new URL(baseUrl + path);
    const headers = {
      "X-Backup-Secret": secret
    };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }
    const req = request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + (url.search || ""),
        method,
        headers,
        timeout: 15e3
      },
      (resp) => {
        let data = "";
        resp.on("data", (c) => {
          data += c;
        });
        resp.on("end", () => {
          let body = {};
          try {
            body = JSON.parse(data);
          } catch {
          }
          const status = resp.statusCode ?? 500;
          resolve({ ok: status >= 200 && status < 300, status, body });
        });
      }
    );
    req.on("error", () => resolve({ ok: false, status: 502, body: { error: "Sidecar unreachable" } }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, status: 504, body: { error: "Sidecar timeout" } });
    });
    if (payload) req.write(payload);
    req.end();
  });
}
function proxyStreamToSidecar(baseUrl, secret, method, path, incoming, contentType = "application/gzip") {
  return new Promise((resolve) => {
    const url = new URL(baseUrl + path);
    const req = request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method,
        headers: {
          "X-Backup-Secret": secret,
          "Content-Type": contentType,
          "Transfer-Encoding": "chunked"
        },
        timeout: 5 * 6e4
      },
      (resp) => {
        let data = "";
        resp.on("data", (c) => {
          data += c;
        });
        resp.on("end", () => {
          let body2 = {};
          try {
            body2 = JSON.parse(data);
          } catch {
          }
          const status = resp.statusCode ?? 500;
          resolve({ ok: status >= 200 && status < 300, status, body: body2 });
        });
      }
    );
    req.on("error", () => resolve({ ok: false, status: 502, body: { error: "Sidecar unreachable" } }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, status: 504, body: { error: "Sidecar timeout" } });
    });
    const { body } = incoming;
    if (Buffer.isBuffer(body) && body.length > 0) {
      req.end(body);
    } else {
      incoming.pipe(req);
    }
  });
}
function proxyStreamFromSidecar(baseUrl, secret, path, clientRes) {
  return new Promise((resolve) => {
    const url = new URL(baseUrl + path);
    const req = request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: "GET",
        headers: { "X-Backup-Secret": secret },
        timeout: 5 * 6e4
      },
      (resp) => {
        const status = resp.statusCode ?? 500;
        if (status >= 400) {
          let data = "";
          resp.on("data", (c) => {
            data += c;
          });
          resp.on("end", () => {
            let body = {};
            try {
              body = JSON.parse(data);
            } catch {
            }
            clientRes.status(status).json(body);
            resolve();
          });
          return;
        }
        if (resp.headers["content-type"]) clientRes.setHeader("Content-Type", resp.headers["content-type"]);
        if (resp.headers["content-disposition"]) clientRes.setHeader("Content-Disposition", resp.headers["content-disposition"]);
        clientRes.status(status);
        resp.pipe(clientRes);
        resp.on("end", resolve);
      }
    );
    req.on("error", () => {
      if (!clientRes.headersSent) clientRes.status(502).json({ error: "Sidecar unreachable" });
      resolve();
    });
    req.on("timeout", () => {
      req.destroy();
      if (!clientRes.headersSent) clientRes.status(504).json({ error: "Sidecar timeout" });
      resolve();
    });
    req.end();
  });
}
function ensureValidId(id, res) {
  if (isValidBackupId(id)) return true;
  res.status(400).json({ error: "Invalid backup ID" });
  return false;
}
function handler(router, context) {
  const env = { ...process.env, ...context.env };
  const sidecarUrl = env.BACKUP_URL;
  const secret = env.BACKUP_SECRET;
  const { database } = context;
  function ensureSidecar(res) {
    if (sidecarUrl && secret) return true;
    res.status(503).json({ error: "Backup sidecar not configured" });
    return false;
  }
  router.get("/list", async (req, res) => {
    if (!await requireBackupAccess(req, res, database)) return;
    if (!ensureSidecar(res)) return;
    const result = await callSidecar(sidecarUrl, secret, "GET", "/list");
    res.status(result.status).json(result.body);
  });
  router.post("/create", async (req, res) => {
    if (!await requireBackupAccess(req, res, database)) return;
    if (!ensureSidecar(res)) return;
    const rawLabel = req.body?.label ?? "";
    const label = typeof rawLabel === "string" && rawLabel.length > 0 && LABEL_RE.test(rawLabel) && rawLabel.length <= LABEL_MAX ? rawLabel : "manual";
    const backupId = generateBackupId(label);
    const scope = req.body?.scope;
    const payload = JSON.stringify({
      backupId,
      source: "manual",
      ...scope && typeof scope === "object" ? { scope } : {}
    });
    const result = await callSidecar(sidecarUrl, secret, "POST", "/run", payload);
    if (result.ok) {
      res.status(202).json({ id: backupId, startedAt: (/* @__PURE__ */ new Date()).toISOString() });
    } else {
      res.status(result.status).json(result.body);
    }
  });
  router.post("/upload", async (req, res) => {
    if (!await requireBackupAccess(req, res, database)) return;
    if (!ensureSidecar(res)) return;
    const result = await proxyStreamToSidecar(
      sidecarUrl,
      secret,
      "POST",
      "/import",
      req
    );
    res.status(result.status).json(result.body);
  });
  router.delete("/:id", async (req, res) => {
    if (!await requireBackupAccess(req, res, database)) return;
    if (!ensureSidecar(res)) return;
    const { id } = req.params;
    if (!ensureValidId(id, res)) return;
    const result = await callSidecar(sidecarUrl, secret, "DELETE", `/backup/${id}`);
    res.status(result.status).json(result.body);
  });
  router.get("/:id/download", async (req, res) => {
    if (!await requireBackupAccess(req, res, database)) return;
    if (!ensureSidecar(res)) return;
    const { id } = req.params;
    if (!ensureValidId(id, res)) return;
    await proxyStreamFromSidecar(sidecarUrl, secret, `/backup/${id}/download`, res);
  });
  router.post("/:id/restore", async (req, res) => {
    if (!await requireBackupAccess(req, res, database)) return;
    if (!ensureSidecar(res)) return;
    const { id } = req.params;
    if (!ensureValidId(id, res)) return;
    const scope = req.body?.scope;
    const payload = JSON.stringify({
      backupId: id,
      ...scope && typeof scope === "object" ? { scope } : {}
    });
    const result = await callSidecar(sidecarUrl, secret, "POST", "/restore", payload);
    res.status(result.status).json(result.body);
  });
  router.post("/:id/cancel", async (req, res) => {
    if (!await requireBackupAccess(req, res, database)) return;
    if (!ensureSidecar(res)) return;
    const { id } = req.params;
    if (!ensureValidId(id, res)) return;
    const result = await callSidecar(sidecarUrl, secret, "POST", "/cancel", JSON.stringify({ backupId: id }));
    res.status(result.status).json(result.body);
  });
  router.get("/config", async (req, res) => {
    if (!await requireBackupAccess(req, res, database)) return;
    if (!ensureSidecar(res)) return;
    const result = await callSidecar(sidecarUrl, secret, "GET", "/config");
    res.status(result.status).json(result.body);
  });
  router.put("/config", async (req, res) => {
    if (!await requireBackupAccess(req, res, database)) return;
    if (!ensureSidecar(res)) return;
    const body = req.body ?? {};
    const payload = JSON.stringify(body);
    const result = await callSidecar(sidecarUrl, secret, "PUT", "/config", payload);
    res.status(result.status).json(result.body);
  });
  router.get("/storage", async (req, res) => {
    if (!await requireBackupAccess(req, res, database)) return;
    if (!ensureSidecar(res)) return;
    const result = await callSidecar(sidecarUrl, secret, "GET", "/storage");
    res.status(result.status).json(result.body);
  });
  router.get("/activity", async (req, res) => {
    if (!await requireBackupAccess(req, res, database)) return;
    if (!ensureSidecar(res)) return;
    const limit = req.query?.limit || "50";
    const result = await callSidecar(sidecarUrl, secret, "GET", `/activity?limit=${limit}`);
    res.status(result.status).json(result.body);
  });
  router.get("/check-access", async (req, res) => {
    if (await requireBackupAccess(req, res, database)) {
      res.json({ access: true });
    }
  });
}
var e0 = {
  id: "backup-api",
  handler
};

const hooks = [];const endpoints = [{name:'backup-api',config:e0}];const operations = [];

export { endpoints, hooks, operations };

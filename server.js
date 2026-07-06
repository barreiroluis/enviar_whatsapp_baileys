import express from "express";
import {
  addQRClient,
  disconnectWhatsAppAccount,
  getDefaultAccountKey,
  getSock,
  getWhatsAppAccountStatus,
  initWhatsApp,
  listWhatsAppRuntimeAccounts,
} from "./whatsapp.js";
import { enviar_mensaje } from "./services/enviar_mensaje.js";
import { procesarRecordatoriosCron } from "./index.js";
import { logError } from "./utils/logger.js";
import { cleanNumber } from "./utils/cleanNumber.js";
import { getCurrentDateTime } from "./utils/date.js";
import { isMySQL, runQuery } from "./database.js";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // 👈 CLAVE

// 📂 Archivos estáticos (QR UI)
app.use(express.static("public"));

// 📋 Logger de todas las peticiones API
app.use((req, res, next) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`[API] ${req.method} ${req.path} — ip:${ip} — ${getCurrentDateTime()}`);
  next();
});

const ID_EMPRESA = Number(process.env.ID_EMPRESA || 0);

function normalizeAccountKey(value = "default") {
  const safe = String(value || "default")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 80);
  return safe || "default";
}

async function ensureNotificationAccountsSchema() {
  if (!isMySQL || !ID_EMPRESA) return;
  await runQuery(`
    CREATE TABLE IF NOT EXISTS whatsapp_notificacion_cuentas (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      id_empresa INT NOT NULL,
      id_sucursal INT NULL,
      nombre VARCHAR(120) NOT NULL DEFAULT '',
      numero VARCHAR(40) NULL,
      account_key VARCHAR(80) NOT NULL,
      es_default TINYINT(1) NOT NULL DEFAULT 0,
      estado VARCHAR(40) NOT NULL DEFAULT 'pendiente_qr',
      session_path VARCHAR(255) NULL,
      url_api_whatsapp_legacy VARCHAR(191) NOT NULL DEFAULT '',
      identifier_bot_notificacion VARCHAR(191) NOT NULL DEFAULT '',
      external_id_notificacion VARCHAR(191) NOT NULL DEFAULT '',
      ultimo_qr_at DATETIME NULL,
      conectado_at DATETIME NULL,
      desconectado_at DATETIME NULL,
      fecha_baja DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_empresa_account_key (id_empresa, account_key),
      KEY idx_empresa_estado (id_empresa, estado),
      KEY idx_empresa_sucursal (id_empresa, id_sucursal)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await runQuery(
    `
    INSERT INTO whatsapp_notificacion_cuentas
      (id_empresa, id_sucursal, nombre, account_key, es_default, estado, session_path)
    VALUES (?, NULL, 'WhatsApp de notificaciones global', 'default', 1, 'legacy_activa', ?)
    ON DUPLICATE KEY UPDATE
      es_default = 1,
      nombre = VALUES(nombre),
      session_path = COALESCE(session_path, VALUES(session_path)),
      updated_at = CURRENT_TIMESTAMP
    `,
    [ID_EMPRESA, process.env.WA_SESSION_PATH || "./sessions"],
  );
}

async function getNotificationAccounts() {
  if (!isMySQL || !ID_EMPRESA) {
    return [
      {
        account_key: getDefaultAccountKey(),
        nombre: "WhatsApp de notificaciones global",
        es_default: 1,
        estado: "runtime",
      },
    ];
  }
  await ensureNotificationAccountsSchema();
  const rows = await runQuery(
    `
    SELECT id, id_empresa, id_sucursal, nombre, numero, account_key, es_default,
           estado, session_path, fecha_baja, created_at, updated_at
    FROM whatsapp_notificacion_cuentas
    WHERE id_empresa = ?
      AND (fecha_baja IS NULL OR fecha_baja = '0000-00-00 00:00:00')
    ORDER BY es_default DESC, id ASC
    `,
    [ID_EMPRESA],
  );
  return rows || [];
}

async function resolveAccountKey({ account_key, id_sucursal } = {}) {
  const explicit = normalizeAccountKey(account_key || "");
  if (explicit && explicit !== "default") return explicit;
  if (String(account_key || "").trim() === "default") return "default";

  const idSucursal = Number(id_sucursal || 0);
  if (isMySQL && ID_EMPRESA && idSucursal > 0) {
    try {
      await ensureNotificationAccountsSchema();
      const rows = await runQuery(
        `
        SELECT account_key
        FROM whatsapp_notificacion_cuentas
        WHERE id_empresa = ?
          AND id_sucursal = ?
          AND (fecha_baja IS NULL OR fecha_baja = '0000-00-00 00:00:00')
        ORDER BY es_default ASC, id ASC
        LIMIT 1
        `,
        [ID_EMPRESA, idSucursal],
      );
      const key = normalizeAccountKey(rows?.[0]?.account_key || "");
      if (key) return key;
    } catch (err) {
      logError("❌ Error resolviendo cuenta por sucursal", err, {
        idSucursal,
      });
    }
  }

  return getDefaultAccountKey();
}

function publicAccountPayload(row) {
  const status = getWhatsAppAccountStatus(row.account_key || "default");
  return {
    id: Number(row.id || 0) || null,
    id_empresa: Number(row.id_empresa || ID_EMPRESA) || ID_EMPRESA || null,
    id_sucursal:
      row.id_sucursal == null ? null : Number(row.id_sucursal || 0) || null,
    nombre: row.nombre || "",
    numero: row.numero || "",
    account_key: normalizeAccountKey(row.account_key || "default"),
    es_default: Number(row.es_default || 0) === 1,
    estado: row.estado || status.status,
    runtime: status,
    fecha_baja: row.fecha_baja || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

app.get("/health", async (req, res) => {
  try {
    let accounts = [];
    try {
      accounts = await getNotificationAccounts();
    } catch (err) {
      logError("⚠️ No se pudo cargar cuentas para /health", err);
    }
    res.json({
      ok: true,
      id_empresa: ID_EMPRESA || null,
      default_account: getWhatsAppAccountStatus(getDefaultAccountKey()),
      accounts: accounts.map(publicAccountPayload),
      runtime: listWhatsAppRuntimeAccounts(),
      timestamp: getCurrentDateTime(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

/* 🔲 QR en tiempo real (SSE) */
app.get("/qr", async (req, res) => {
  try {
    await initWhatsApp(getDefaultAccountKey());
  } catch (err) {
    logError("❌ Error inicializando cuenta default para QR", err, {
      accountKey: getDefaultAccountKey(),
    });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  res.flushHeaders();

  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`[SSE] cliente conectado — ip:${ip} — ${getCurrentDateTime()}`);
  res.write(`data: ${JSON.stringify({ status: "listening" })}\n\n`);
  console.log(`[SSE] → {status:"listening"}`);

  const _write = res.write.bind(res);
  res.write = (chunk) => {
    try {
      const raw = chunk.toString().replace(/^data: /, "").trim();
      const parsed = JSON.parse(raw);
      console.log(`[SSE] → ${JSON.stringify(parsed)}`);
    } catch {}
    return _write(chunk);
  };

  res.on("close", () => {
    console.log(`[SSE] cliente desconectado — ip:${ip}`);
  });

  addQRClient(res);
});

app.get("/accounts", async (req, res) => {
  try {
    const accounts = await getNotificationAccounts();
    res.json({
      ok: true,
      id_empresa: ID_EMPRESA || null,
      accounts: accounts.map(publicAccountPayload),
      runtime: listWhatsAppRuntimeAccounts(),
    });
  } catch (err) {
    logError("❌ Error en /accounts", err);
    res.status(500).json({ ok: false, msg: err.message });
  }
});

app.post("/accounts", async (req, res) => {
  try {
    if (!isMySQL || !ID_EMPRESA) {
      return res.status(503).json({
        ok: false,
        msg: "Base MySQL no disponible para crear cuentas.",
      });
    }
    await ensureNotificationAccountsSchema();
    const requestedKey = normalizeAccountKey(req.body.account_key || "");
    const accountKey =
      requestedKey && requestedKey !== "default"
        ? requestedKey
        : `wa_${Date.now().toString(36)}`;
    const nombre =
      String(req.body.nombre || "").trim() ||
      `WhatsApp notificaciones ${accountKey}`;
    const idSucursal = Number(req.body.id_sucursal || 0) || null;

    await runQuery(
      `
      INSERT INTO whatsapp_notificacion_cuentas
        (id_empresa, id_sucursal, nombre, account_key, es_default, estado, session_path)
      VALUES (?, ?, ?, ?, 0, 'pendiente_qr', ?)
      `,
      [ID_EMPRESA, idSucursal, nombre, accountKey, `./sessions/${accountKey}`],
    );
    await initWhatsApp(accountKey);

    res.status(201).json({
      ok: true,
      account_key: accountKey,
      msg: "Cuenta de notificaciones creada. Genere el QR para vincularla.",
      runtime: getWhatsAppAccountStatus(accountKey),
    });
  } catch (err) {
    logError("❌ Error creando cuenta WhatsApp notificación", err);
    res.status(500).json({ ok: false, msg: err.message });
  }
});

app.get("/accounts/:accountKey/qr", async (req, res) => {
  const accountKey = normalizeAccountKey(req.params.accountKey);
  try {
    await initWhatsApp(accountKey);
  } catch (err) {
    logError("❌ Error inicializando cuenta para QR", err, { accountKey });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ status: "listening", account_key: accountKey })}\n\n`);
  addQRClient(res, accountKey);
});

app.post("/accounts/:accountKey/disconnect", async (req, res) => {
  const accountKey = normalizeAccountKey(req.params.accountKey);

  try {
    await ensureNotificationAccountsSchema();
    await disconnectWhatsAppAccount(accountKey);
    res.json({
      ok: true,
      account_key: accountKey,
      msg: "Sesión de WhatsApp cerrada. Genere un nuevo QR para volver a vincularla.",
      runtime: getWhatsAppAccountStatus(accountKey),
    });
  } catch (err) {
    logError("❌ Error cerrando sesión de cuenta WhatsApp notificación", err, {
      accountKey,
    });
    res.status(500).json({ ok: false, msg: err.message });
  }
});

app.delete("/accounts/:accountKey", async (req, res) => {
  const accountKey = normalizeAccountKey(req.params.accountKey);
  if (accountKey === getDefaultAccountKey()) {
    return res.status(422).json({
      ok: false,
      msg: "No se puede eliminar la cuenta default incluida.",
    });
  }

  try {
    await disconnectWhatsAppAccount(accountKey);
    if (isMySQL && ID_EMPRESA) {
      await ensureNotificationAccountsSchema();
      await runQuery(
        `
        UPDATE whatsapp_notificacion_cuentas
        SET fecha_baja = NOW(), estado = 'eliminada'
        WHERE id_empresa = ? AND account_key = ?
        LIMIT 1
        `,
        [ID_EMPRESA, accountKey],
      );
    }
    res.json({ ok: true, msg: "Cuenta desvinculada y sesión eliminada." });
  } catch (err) {
    logError("❌ Error eliminando cuenta WhatsApp notificación", err, {
      accountKey,
    });
    res.status(500).json({ ok: false, msg: err.message });
  }
});

/* 📤 Handler de envío */
const sendWithApi = async (req, res) => {
  const {
    to,
    message,
    adjunto,
    adjunto_tipo,
    adjunto_mimetype,
    adjunto_nombre,
    account_key,
    id_sucursal,
    interactive_buttons,
    botones_interactivos,
  } = req.body;
  const respondSend = (status, payload) => {
    console.log("📡 Respuesta /send", {
      status,
      payload,
      timestamp: getCurrentDateTime(),
    });
    return res.status(status).json(payload);
  };

  try {
    if (!to || !message) {
      return respondSend(400, {
        ok: false,
        msg: "Faltan parámetros",
      });
    }

    const cleanMessage = message.trim();

    if (!cleanMessage) {
      return respondSend(400, {
        ok: false,
        msg: "Mensaje vacío",
      });
    }

    if (message.length > 4000) {
      return respondSend(400, {
        ok: false,
        msg: "Mensaje demasiado largo",
      });
    }

    const toJid = cleanNumber(to);

    if (!toJid) {
      return respondSend(400, {
        ok: false,
        msg: "Número inválido",
      });
    }

    const accountKey = await resolveAccountKey({ account_key, id_sucursal });
    await initWhatsApp(accountKey);

    if (!getSock(accountKey)?.user) {
      return respondSend(503, {
        ok: false,
        msg: `WhatsApp no conectado (${accountKey})`,
        account_key: accountKey,
      });
    }

    const result = await enviar_mensaje({
      to: toJid,
      message: cleanMessage,
      adjunto,
      adjunto_tipo,
      adjunto_mimetype,
      adjunto_nombre,
      id_operador: 0, // cron / sistema
      source: "api-post",
      account_key: accountKey,
      interactive_buttons: interactive_buttons ?? botones_interactivos,
    });

    return respondSend(200, {
      ok: true,
      msg: result.msg, // "Whatsapp Enviado"
      id_msg: result.id_msg,
      account_key: accountKey,
      interactive_mode: result.interactive_mode,
    });
  } catch (error) {
    logError("❌ Error en /send", error, { to });
    return respondSend(500, {
      ok: false,
      msg: error.message,
    });
  }
};

/* 📤 Endpoint */
app.post("/send", sendWithApi);

app.post("/run-cron-now", async (req, res) => {
  console.log(`[CRON] ejecución manual solicitada — ${getCurrentDateTime()}`);
  const sock = getSock(getDefaultAccountKey());

  if (!sock?.user) {
    return res.status(400).json({
      ok: false,
      msg: "WhatsApp no conectado",
    });
  }

  try {
    await procesarRecordatoriosCron();

    res.json({
      ok: true,
      msg: "Cron ejecutado manualmente",
    });
  } catch (e) {
    logError("❌ Error en /run-cron-now", e);
    res.status(500).json({
      ok: false,
      msg: e.message,
    });
  }
});

export default app;

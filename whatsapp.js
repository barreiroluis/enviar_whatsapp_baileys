import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import { rm } from "node:fs/promises";
import path from "node:path";
import Pino from "pino";
import { isMySQL, runQuery } from "./database.js";
import { logError } from "./utils/logger.js";

const DEFAULT_ACCOUNT_KEY = "default";
const ID_EMPRESA = Number(process.env.ID_EMPRESA || 0);
const LEGACY_SESSION_PATH = process.env.WA_SESSION_PATH || "./sessions";
const MULTI_SESSION_ROOT =
  process.env.WA_MULTI_SESSION_ROOT || process.env.WA_SESSION_ROOT || "./sessions";
const BASE_RECONNECT_DELAY_MS = Number(
  process.env.WA_RECONNECT_DELAY_MS || 5000,
);
const MAX_RECONNECT_DELAY_MS = 60000;
const MAX_RECONNECT_ATTEMPTS = Number(
  process.env.WA_MAX_RECONNECT_ATTEMPTS || 8,
);
const RECONNECT_COOLDOWN_MS = Number(
  process.env.WA_RECONNECT_COOLDOWN_MS || 300000,
);
const RECONNECT_JITTER_RATIO = 0.2;
const WA_SOCKET_VERSION = [2, 3000, 1033893291];
const WA_BAILEYS_LOG_LEVEL = process.env.WA_BAILEYS_LOG_LEVEL || "silent";

const sessions = new Map();

function normalizeAccountKey(accountKey = DEFAULT_ACCOUNT_KEY) {
  const raw = String(accountKey || DEFAULT_ACCOUNT_KEY).trim();
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return safe || DEFAULT_ACCOUNT_KEY;
}

function sessionPathFor(accountKey) {
  const key = normalizeAccountKey(accountKey);
  if (key === DEFAULT_ACCOUNT_KEY) {
    return LEGACY_SESSION_PATH;
  }
  return path.join(MULTI_SESSION_ROOT, key);
}

function getSessionState(accountKey = DEFAULT_ACCOUNT_KEY) {
  const key = normalizeAccountKey(accountKey);
  if (!sessions.has(key)) {
    sessions.set(key, {
      accountKey: key,
      sessionPath: sessionPathFor(key),
      sock: null,
      currentQR: null,
      connectionStatus: "disconnected",
      reconnectTimeout: null,
      reconnectAttempts: 0,
      reconnectCooldownUntil: 0,
      isInitializing: false,
      manualDisconnect: false,
      suppressReconnectUntil: 0,
      qrClients: new Set(),
    });
  }
  return sessions.get(key);
}

function extractConnectedPhone(sock) {
  const raw = String(sock?.user?.id || "").split(":")[0] || "";
  return raw.replace(/\D/g, "").slice(0, 40);
}

async function updateNotificationAccountStatus(
  accountKey,
  {
    estado,
    numero = null,
    touchQr = false,
    touchConnected = false,
    touchDisconnected = false,
  } = {},
) {
  if (!isMySQL || !ID_EMPRESA || !estado) return;
  try {
    await runQuery(
      `
      UPDATE whatsapp_notificacion_cuentas
      SET estado = ?,
          numero = COALESCE(NULLIF(?, ''), numero),
          ultimo_qr_at = CASE WHEN ? = 1 THEN NOW() ELSE ultimo_qr_at END,
          conectado_at = CASE WHEN ? = 1 THEN NOW() ELSE conectado_at END,
          desconectado_at = CASE WHEN ? = 1 THEN NOW() ELSE desconectado_at END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id_empresa = ?
        AND account_key = ?
        AND (fecha_baja IS NULL OR fecha_baja = '0000-00-00 00:00:00')
      LIMIT 1
      `,
      [
        estado,
        numero || "",
        touchQr ? 1 : 0,
        touchConnected ? 1 : 0,
        touchDisconnected ? 1 : 0,
        ID_EMPRESA,
        normalizeAccountKey(accountKey),
      ],
    );
  } catch (err) {
    if (err?.code !== "ER_NO_SUCH_TABLE") {
      logError("❌ Error actualizando estado de cuenta WhatsApp", err, {
        accountKey,
        estado,
      });
    }
  }
}

export async function initWhatsApp(accountKey = DEFAULT_ACCOUNT_KEY) {
  const stateRef = getSessionState(accountKey);
  if (stateRef.sock?.user && stateRef.connectionStatus === "connected") {
    return;
  }
  if (
    stateRef.sock &&
    ["connecting", "qr"].includes(stateRef.connectionStatus)
  ) {
    return;
  }
  if (stateRef.isInitializing) return;
  stateRef.isInitializing = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(
      stateRef.sessionPath,
    );
    console.log(
      `🧩 WA ${stateRef.accountKey} version fija: ${WA_SOCKET_VERSION.join(".")}`,
    );

    stateRef.connectionStatus = "connecting";
    stateRef.sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      version: WA_SOCKET_VERSION,
      logger: Pino({ level: WA_BAILEYS_LOG_LEVEL }),
      syncFullHistory: false,
      browser: ["Windows", "Google Chrome", "145.0.0"],
      fireInitQueries: false,
      shouldSyncHistoryMessage: () => false,
      shouldIgnoreJid: (jid) => jid === "status@broadcast",
    });

    stateRef.sock.ev.on("creds.update", saveCreds);

    stateRef.sock.ev.on(
      "connection.update",
      async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
          stateRef.currentQR = qr;
          stateRef.connectionStatus = "qr";
          await updateNotificationAccountStatus(stateRef.accountKey, {
            estado: "pendiente_qr",
            touchQr: true,
          });
          console.log(`🔄 Nuevo QR generado (${stateRef.accountKey})`);
          notifyQRClients(stateRef, { status: "qr", qr });
        }

        if (connection === "open") {
          stateRef.manualDisconnect = false;
          stateRef.connectionStatus = "connected";
          stateRef.currentQR = null;
          stateRef.reconnectAttempts = 0;
          stateRef.reconnectCooldownUntil = 0;
          clearReconnectTimeout(stateRef);
          await updateNotificationAccountStatus(stateRef.accountKey, {
            estado: "conectada",
            numero: extractConnectedPhone(stateRef.sock),
            touchConnected: true,
          });
          console.log(`✅ WhatsApp conectado (${stateRef.accountKey})`);
          notifyQRClients(stateRef, { status: "connected" });
        }

        if (connection === "close") {
          stateRef.connectionStatus = "disconnected";
          const wasManualDisconnect =
            stateRef.manualDisconnect ||
            stateRef.suppressReconnectUntil > Date.now();
          stateRef.manualDisconnect = false;
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const reason =
            statusCode !== undefined ? DisconnectReason[statusCode] : "unknown";
          const isSessionLost =
            statusCode === DisconnectReason.loggedOut || reason === "loggedOut";

          logError(
            `⚠️ WhatsApp desconectado (${stateRef.accountKey})`,
            lastDisconnect?.error || new Error("Desconectado"),
            { statusCode, reason, accountKey: stateRef.accountKey },
          );

          notifyQRClients(stateRef, { status: "disconnected", reason });

          if (wasManualDisconnect) {
            stateRef.sock = null;
            stateRef.currentQR = null;
            clearReconnectTimeout(stateRef);
            await updateNotificationAccountStatus(stateRef.accountKey, {
              estado: "desconectada",
              touchDisconnected: true,
            });
            notifyQRClients(stateRef, {
              status: "disconnected",
              reason: "manual_disconnect",
              requiresQr: true,
            });
            return;
          }

          if (isSessionLost) {
            stateRef.connectionStatus = "session_lost";
            stateRef.currentQR = null;
            clearReconnectTimeout(stateRef);
            await updateNotificationAccountStatus(stateRef.accountKey, {
              estado: "session_lost",
              touchDisconnected: true,
            });
            await clearSessionFiles(stateRef);
            notifyQRClients(stateRef, {
              status: "session_lost",
              reason,
              requiresQr: true,
            });
          } else {
            await updateNotificationAccountStatus(stateRef.accountKey, {
              estado: "desconectada",
              touchDisconnected: true,
            });
          }

          stateRef.sock = null;
          scheduleReconnect(stateRef, { reason, immediate: isSessionLost });
        }
      },
    );

    stateRef.sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      const msg = messages[0];
      if (!msg.message) return;

      const from = msg.key.remoteJid;
      const isFromMe = msg.key.fromMe;

      if (isFromMe) return;
      if (from === "status@broadcast") return;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        null;

      console.log("📩 Nuevo mensaje");
      console.log("Cuenta:", stateRef.accountKey);
      console.log("De:", from);
      console.log("Texto:", text);
      console.log("______________________");
    });
  } finally {
    stateRef.isInitializing = false;
  }
}

export function getSock(accountKey = DEFAULT_ACCOUNT_KEY) {
  return getSessionState(accountKey).sock;
}

export function getDefaultAccountKey() {
  return DEFAULT_ACCOUNT_KEY;
}

export function getWhatsAppAccountStatus(accountKey = DEFAULT_ACCOUNT_KEY) {
  const stateRef = getSessionState(accountKey);
  return {
    account_key: stateRef.accountKey,
    session_path: stateRef.sessionPath,
    status: stateRef.sock?.user ? "connected" : stateRef.connectionStatus,
    connected: Boolean(stateRef.sock?.user),
    has_qr: Boolean(stateRef.currentQR),
    qr_clients: stateRef.qrClients.size,
    user: stateRef.sock?.user || null,
  };
}

export function listWhatsAppRuntimeAccounts() {
  return Array.from(sessions.keys()).map((accountKey) =>
    getWhatsAppAccountStatus(accountKey),
  );
}

export async function disconnectWhatsAppAccount(accountKey = DEFAULT_ACCOUNT_KEY) {
  const stateRef = getSessionState(accountKey);
  clearReconnectTimeout(stateRef);
  stateRef.reconnectAttempts = 0;
  stateRef.reconnectCooldownUntil = 0;
  stateRef.currentQR = null;
  stateRef.manualDisconnect = true;
  stateRef.suppressReconnectUntil = Date.now() + 30000;

  try {
    stateRef.sock?.end?.();
  } catch (err) {
    logError("⚠️ No se pudo cerrar socket WhatsApp con end()", err, {
      accountKey: stateRef.accountKey,
    });
  }

  try {
    stateRef.sock?.ws?.close?.();
  } catch (err) {
    logError("⚠️ No se pudo cerrar websocket WhatsApp", err, {
      accountKey: stateRef.accountKey,
    });
  }

  stateRef.sock = null;
  stateRef.connectionStatus = "disconnected";
  await clearSessionFiles(stateRef);
  await updateNotificationAccountStatus(stateRef.accountKey, {
    estado: "desconectada",
    touchDisconnected: true,
  });
  notifyQRClients(stateRef, {
    status: "disconnected",
    reason: "manual_disconnect",
    requiresQr: true,
  });
  stateRef.manualDisconnect = false;
}

/* ===== SSE helpers ===== */

export function addQRClient(res, accountKey = DEFAULT_ACCOUNT_KEY) {
  const stateRef = getSessionState(accountKey);
  stateRef.qrClients.add(res);

  if (stateRef.sock?.user || stateRef.connectionStatus === "connected") {
    res.write(`data: ${JSON.stringify({ status: "connected" })}\n\n`);
  } else if (stateRef.connectionStatus === "session_lost") {
    res.write(
      `data: ${JSON.stringify({ status: "session_lost", requiresQr: true })}\n\n`,
    );
  } else if (stateRef.connectionStatus === "disconnected") {
    res.write(`data: ${JSON.stringify({ status: "disconnected" })}\n\n`);
  }

  if (stateRef.currentQR) {
    res.write(`data: ${JSON.stringify({ qr: stateRef.currentQR })}\n\n`);
  }

  res.on("close", () => {
    stateRef.qrClients.delete(res);
  });
}

function notifyQRClients(stateRef, data) {
  console.log(
    `[SSE] ${stateRef.accountKey} broadcast (${stateRef.qrClients.size} clientes) → ${JSON.stringify(data)}`,
  );
  for (const client of stateRef.qrClients) {
    client.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

function clearReconnectTimeout(stateRef) {
  if (stateRef.reconnectTimeout) {
    clearTimeout(stateRef.reconnectTimeout);
    stateRef.reconnectTimeout = null;
  }
}

function scheduleReconnect(stateRef, { reason = "unknown", immediate = false } = {}) {
  if (stateRef.reconnectTimeout) return;

  const now = Date.now();

  if (stateRef.reconnectCooldownUntil > now) {
    const pendingMs = stateRef.reconnectCooldownUntil - now;
    console.log(
      `🧊 Cooldown activo ${stateRef.accountKey}. Reintento pausado por ${pendingMs}ms (reason: ${reason})`,
    );
    stateRef.reconnectTimeout = setTimeout(() => {
      stateRef.reconnectTimeout = null;
      initWhatsApp(stateRef.accountKey).catch((err) => {
        logError("❌ Error al reconectar WhatsApp tras cooldown", err, {
          accountKey: stateRef.accountKey,
        });
        scheduleReconnect(stateRef, { reason: "cooldown_init_error" });
      });
    }, pendingMs);
    return;
  }

  stateRef.reconnectAttempts += 1;

  if (stateRef.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    stateRef.reconnectAttempts = 0;
    stateRef.reconnectCooldownUntil = now + RECONNECT_COOLDOWN_MS;
    console.log(
      `🧊 Máximo de reintentos alcanzado (${stateRef.accountKey}). Cooldown de ${RECONNECT_COOLDOWN_MS}ms`,
    );
    notifyQRClients(stateRef, {
      status: "reconnect_cooldown",
      reason,
      delayMs: RECONNECT_COOLDOWN_MS,
    });
    scheduleReconnect(stateRef, { reason: "cooldown" });
    return;
  }

  const baseDelay = immediate
    ? 1000
    : Math.min(
        BASE_RECONNECT_DELAY_MS * 2 ** (stateRef.reconnectAttempts - 1),
        MAX_RECONNECT_DELAY_MS,
      );
  const jitter =
    immediate || baseDelay <= 1000
      ? 0
      : Math.floor(
          baseDelay *
            (Math.random() * RECONNECT_JITTER_RATIO * 2 -
              RECONNECT_JITTER_RATIO),
        );
  const delay = Math.max(1000, baseDelay + jitter);

  console.log(
    `♻️ Reintentando conexión ${stateRef.accountKey} en ${delay}ms (intento ${stateRef.reconnectAttempts}, reason: ${reason})`,
  );
  notifyQRClients(stateRef, {
    status: "reconnecting",
    reason,
    attempt: stateRef.reconnectAttempts,
    delayMs: delay,
  });

  stateRef.reconnectTimeout = setTimeout(() => {
    stateRef.reconnectTimeout = null;
    initWhatsApp(stateRef.accountKey).catch((err) => {
      logError("❌ Error al reintentar conexión de WhatsApp", err, {
        accountKey: stateRef.accountKey,
      });
      scheduleReconnect(stateRef, { reason: "init_error" });
    });
  }, delay);
}

export async function clearSessionFiles(stateRefOrAccountKey = DEFAULT_ACCOUNT_KEY) {
  const stateRef =
    typeof stateRefOrAccountKey === "string"
      ? getSessionState(stateRefOrAccountKey)
      : stateRefOrAccountKey;
  try {
    await rm(stateRef.sessionPath, { recursive: true, force: true });
    console.log(
      `🧹 Sesión de WhatsApp limpiada (${stateRef.accountKey}). Se pedirá nuevo QR.`,
    );
  } catch (err) {
    logError("❌ Error limpiando sesiones de WhatsApp", err, {
      sessionPath: stateRef.sessionPath,
      accountKey: stateRef.accountKey,
    });
  }
}

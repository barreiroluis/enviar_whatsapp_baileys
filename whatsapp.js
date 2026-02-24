import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { rm } from "node:fs/promises";
import Pino from "pino";
import { logError } from "./utils/logger.js";

let sock = null;
let currentQR = null;
let connectionStatus = "disconnected";
let reconnectTimeout = null;
let reconnectAttempts = 0;
let isInitializing = false;
let activeSocketId = 0;
let cachedSocketVersion = null;
const SESSION_PATH = process.env.WA_SESSION_PATH || "./sessions";
const BASE_RECONNECT_DELAY_MS = Number(
  process.env.WA_RECONNECT_DELAY_MS || 5000,
);
const MAX_RECONNECT_DELAY_MS = 60000;
const qrClients = new Set(); // clientes SSE

export async function initWhatsApp() {
  if (isInitializing) return;
  isInitializing = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
    const waVersion = await resolveSocketVersion();
    const socketId = ++activeSocketId;
    const nextSock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      version: waVersion,
      logger: Pino({ level: "fatal" }),
      syncFullHistory: false,
    });
    sock = nextSock;

    nextSock.ev.on("creds.update", saveCreds);

    nextSock.ev.on(
      "connection.update",
      async ({ connection, lastDisconnect, qr }) => {
        if (socketId !== activeSocketId || sock !== nextSock) return;

        if (qr) {
          currentQR = qr;
          connectionStatus = "qr";
          console.log("🔄 Nuevo QR generado");
          notifyQRClients({ status: "qr", qr });
        }

        if (connection === "open") {
          connectionStatus = "connected";
          currentQR = null;
          reconnectAttempts = 0;
          clearReconnectTimeout();
          console.log("✅ WhatsApp conectado");
          notifyQRClients({ status: "connected" });
        }

        if (connection === "close") {
          connectionStatus = "disconnected";
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const reason =
            statusCode !== undefined ? DisconnectReason[statusCode] : "unknown";
          const isSessionLost =
            statusCode === DisconnectReason.loggedOut || reason === "loggedOut";

          logError(
            "⚠️ WhatsApp desconectado",
            lastDisconnect?.error || new Error("Desconectado"),
            { statusCode, reason },
          );

          notifyQRClients({ status: "disconnected", reason });

          if (isSessionLost) {
            connectionStatus = "session_lost";
            currentQR = null;
            clearReconnectTimeout();
            await clearSessionFiles();
            notifyQRClients({
              status: "session_lost",
              reason,
              requiresQr: true,
            });
          }

          sock = null;
          scheduleReconnect({ reason, immediate: isSessionLost });
        }
      },
    );

    nextSock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (socketId !== activeSocketId || sock !== nextSock) return;
      if (type !== "notify") return;

      const msg = messages[0];
      if (!msg.message) return;

      const from = msg.key.remoteJid; // jid del remitente
      const isFromMe = msg.key.fromMe; // true si lo envió el bot

      // ❌ ignorar mensajes propios
      if (isFromMe) return;

      // 🚫 IGNORAR ESTADOS
      if (from === "status@broadcast") return;

      // 📩 texto normal
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        null;

      console.log("📩 Nuevo mensaje");
      console.log("De:", from);
      console.log("Texto:", text);
      console.log("______________________");
    });
  } finally {
    isInitializing = false;
  }
}

export function getSock() {
  return sock;
}

export function getConnectionStatus() {
  return connectionStatus;
}

export function isWhatsAppConnected() {
  return connectionStatus === "connected" && Boolean(sock?.user);
}

/* ===== SSE helpers ===== */

export function addQRClient(res) {
  qrClients.add(res);

  // enviar estado actual al conectar (evita quedarse en "listening")
  if (connectionStatus === "connected") {
    res.write(`data: ${JSON.stringify({ status: "connected" })}\n\n`);
  } else if (connectionStatus === "reconnecting") {
    res.write(`data: ${JSON.stringify({ status: "reconnecting" })}\n\n`);
  } else if (connectionStatus === "session_lost") {
    res.write(
      `data: ${JSON.stringify({ status: "session_lost", requiresQr: true })}\n\n`,
    );
  } else if (connectionStatus === "disconnected") {
    res.write(`data: ${JSON.stringify({ status: "disconnected" })}\n\n`);
  }

  // si hay QR vigente, también enviarlo
  if (currentQR) {
    res.write(`data: ${JSON.stringify({ qr: currentQR })}\n\n`);
  }

  res.on("close", () => {
    qrClients.delete(res);
  });
}

function notifyQRClients(data) {
  for (const client of qrClients) {
    try {
      client.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      qrClients.delete(client);
    }
  }
}

function clearReconnectTimeout() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
}

function scheduleReconnect({ reason = "unknown", immediate = false } = {}) {
  if (reconnectTimeout || isInitializing) return;

  connectionStatus = "reconnecting";
  reconnectAttempts += 1;
  const delay = immediate
    ? 1000
    : Math.min(
        BASE_RECONNECT_DELAY_MS * 2 ** (reconnectAttempts - 1),
        MAX_RECONNECT_DELAY_MS,
      );

  console.log(
    `♻️ Reintentando conexión en ${delay}ms (intento ${reconnectAttempts}, reason: ${reason})`,
  );
  notifyQRClients({
    status: "reconnecting",
    reason,
    attempt: reconnectAttempts,
    delayMs: delay,
  });

  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null;
    initWhatsApp().catch((err) => {
      logError("❌ Error al reintentar conexión de WhatsApp", err);
      scheduleReconnect({ reason: "init_error" });
    });
  }, delay);
}

function parseVersion(raw) {
  if (!raw) return null;

  const parts = String(raw)
    .split(/[\s,./-]+/)
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));

  if (
    parts.length !== 3 ||
    parts.some((v) => !Number.isInteger(v) || v <= 0)
  ) {
    return null;
  }

  return [parts[0], parts[1], parts[2]];
}

async function resolveSocketVersion() {
  if (cachedSocketVersion) return cachedSocketVersion;

  const envVersion = parseVersion(process.env.WA_VERSION);

  if (envVersion) {
    cachedSocketVersion = envVersion;
    console.log(`🧩 WA version fija por WA_VERSION: ${envVersion.join(".")}`);
    return cachedSocketVersion;
  }

  if (process.env.WA_VERSION) {
    logError(
      "⚠️ WA_VERSION inválida, se ignora",
      new Error("Formato esperado: X.Y.Z o X,Y,Z"),
      { value: process.env.WA_VERSION },
    );
  }

  const versionResult = await fetchLatestBaileysVersion();
  cachedSocketVersion = versionResult.version;

  if (!versionResult.isLatest) {
    logError(
      "⚠️ No se pudo obtener última versión recomendada de Baileys, usando fallback",
      versionResult.error,
      { version: cachedSocketVersion.join(".") },
    );
  } else {
    console.log(`🧩 Baileys version recomendada: ${cachedSocketVersion.join(".")}`);
  }

  return cachedSocketVersion;
}

async function clearSessionFiles() {
  try {
    await rm(SESSION_PATH, { recursive: true, force: true });
    console.log("🧹 Sesión de WhatsApp limpiada. Se pedirá nuevo QR.");
  } catch (err) {
    logError("❌ Error limpiando sesiones de WhatsApp", err, {
      sessionPath: SESSION_PATH,
    });
  }
}

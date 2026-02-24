import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion,
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
    const waVersionResult = await fetchLatestWaWebVersion();
    const waVersion = waVersionResult.version;

    if (!waVersionResult.isLatest) {
      logError(
        "⚠️ No se pudo obtener la última versión de WA Web, usando fallback de Baileys",
        waVersionResult.error,
        { version: waVersion.join(".") },
      );
    } else {
      console.log(`🧩 WA Web version: ${waVersion.join(".")}`);
    }

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      version: waVersion,
      logger: Pino({ level: "fatal" }),
      syncFullHistory: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on(
      "connection.update",
      async ({ connection, lastDisconnect, qr }) => {
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

          scheduleReconnect({ reason, immediate: isSessionLost });
        }
      },
    );

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
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

/* ===== SSE helpers ===== */

export function addQRClient(res) {
  qrClients.add(res);

  // enviar estado actual al conectar (evita quedarse en "listening")
  if (sock?.user || connectionStatus === "connected") {
    res.write(`data: ${JSON.stringify({ status: "connected" })}\n\n`);
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
    client.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

function clearReconnectTimeout() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
}

function scheduleReconnect({ reason = "unknown", immediate = false } = {}) {
  if (reconnectTimeout) return;

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

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import Pino from "pino";
import { logError } from "./utils/logger.js";

let sock = null;
let currentQR = null;
let connectionStatus = "disconnected";
const qrClients = new Set(); // clientes SSE

export async function initWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("./sessions");

  sock = makeWASocket({
    auth: state,
    logger: Pino({ level: "fatal" }),
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQR = qr;
      connectionStatus = "qr";
      console.log("🔄 Nuevo QR generado");
      notifyQRClients({ qr });
    }

    if (connection === "open") {
      connectionStatus = "connected";
      currentQR = null;
      console.log("✅ WhatsApp conectado");
      notifyQRClients({ status: "connected" });
    }

    if (connection === "close") {
      connectionStatus = "disconnected";
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason =
        statusCode !== undefined ? DisconnectReason[statusCode] : "unknown";

      logError(
        "⚠️ WhatsApp desconectado",
        lastDisconnect?.error || new Error("Desconectado"),
        { statusCode, reason },
      );

      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;

      notifyQRClients({ status: "disconnected", reason });

      if (shouldReconnect) initWhatsApp();
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    const msg = messages[0];
    if (!msg.message) return;

    const from = msg.key.remoteJid; // jid del remitente
    const isFromMe = msg.key.fromMe; // true si lo envió el bot
    const messageId = msg.key.id;

    // ❌ ignorar mensajes propios
    if (isFromMe) return;

    // 🚫 IGNORAR ESTADOS
    if (from === "status@broadcast") return;

    // 📩 texto normal
    const text =
      msg.message.conversation || msg.message.extendedTextMessage?.text || null;

    console.log("📩 Nuevo mensaje");
    console.log("De:", from);
    console.log("Texto:", text);
    console.log("______________________");
  });
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

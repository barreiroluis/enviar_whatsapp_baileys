import express from "express";
import { getSock, addQRClient } from "./whatsapp.js";
import { enviar_mensaje } from "./services/enviar_mensaje.js";
import { procesarRecordatoriosCron } from "./index.js";
import { logError } from "./utils/logger.js";
import { cleanNumber } from "./utils/cleanNumber.js";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // 👈 CLAVE

// 📂 Archivos estáticos (QR UI)
app.use(express.static("public"));

/* 🔲 QR en tiempo real (SSE) */
app.get("/qr", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ status: "listening" })}\n\n`);

  addQRClient(res);
});

/* 📤 Handler de envío */
const sendWithApi = async (req, res) => {
  const { to, message, adjunto } = req.body;
  const respondSend = (status, payload) => {
    console.log("📡 Respuesta /send", {
      status,
      payload,
      timestamp: new Date().toISOString(),
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

    if (!getSock()?.user) {
      return respondSend(503, {
        ok: false,
        msg: "WhatsApp no conectado",
      });
    }

    const result = await enviar_mensaje({
      to: toJid,
      message: cleanMessage,
      adjunto,
      id_operador: 0, // cron / sistema
      source: "api-post",
    });

    return respondSend(200, {
      ok: true,
      msg: result.msg, // "Whatsapp Enviado"
      id_msg: result.id_msg,
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
  const sock = getSock();

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

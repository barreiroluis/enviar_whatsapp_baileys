import { getSock } from "../whatsapp.js";
import { saveMessageMysql } from "../adapter/mysql.js";
import { cleanNumber } from "../utils/cleanNumber.js";
import { getMediaTypeFromUrl, getFileNameFromUrl } from "../utils/media.js";

export async function enviar_mensaje({
  to,
  message,
  adjunto = null,
  id_operador = 0, // cron = 0
}) {
  const sock = getSock();

  if (!sock || !sock.user) {
    throw new Error("WhatsApp no conectado");
  }

  if (!to || !message) {
    throw new Error("Parámetros inválidos");
  }

  // 👈 cleanNumber YA devuelve JID
  const fromJid = cleanNumber(sock.user.id.split(":")[0]);
  const toJid = cleanNumber(to);

  if (!toJid) {
    throw new Error("Número inválido");
  }

  // 📎 Media (pendiente)
  let sentMessage;

  // 📎 CON ADJUNTO (URL)
  if (adjunto) {
    const mediaType = getMediaTypeFromUrl(adjunto);

    if (!mediaType) {
      throw new Error("Tipo de adjunto no soportado");
    }

    const fileName = getFileNameFromUrl(adjunto);

    sentMessage = await sock.sendMessage(toJid, {
      [mediaType]: { url: adjunto },
      fileName: mediaType === "document" ? fileName : undefined,
      caption: message?.trim() || undefined,
    });
  } else {
    // 📩 SOLO TEXTO
    sentMessage = await sock.sendMessage(toJid, {
      text: message.trim(),
    });
  }

  const id_msg = sentMessage?.key?.id || "";

  // 💾 Guardar SOLO lo que manda el sistema
  if (process.env.DATABASE === "mysql") {
    await saveMessageMysql(
      fromJid.replace("@s.whatsapp.net", ""), // guardar limpio como antes
      toJid.replace("@s.whatsapp.net", ""),
      message.trim(),
      null,
      id_msg,
      "",
      id_operador,
    );
  }

  return "Whatsapp Enviado";
}

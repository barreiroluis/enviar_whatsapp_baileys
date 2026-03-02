import { getSock } from "../whatsapp.js";
import { saveMessageMysql } from "../adapter/mysql.js";
import { cleanNumber, jidToPhone, toCrmJid } from "../utils/cleanNumber.js";
import { getCurrentDateTime } from "../utils/date.js";
import { getMediaTypeFromUrl, getFileNameFromUrl } from "../utils/media.js";
import { resolveAppTimeZone } from "../utils/timezone.js";

export async function enviar_mensaje({
  to,
  message,
  adjunto = null,
  id_operador = 0, // cron = 0
  source = "system",
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

  if (!fromJid || !toJid) {
    throw new Error("Número inválido");
  }

  const fromPhone = jidToPhone(fromJid);
  const toPhone = jidToPhone(toJid);

  if (!fromPhone || !toPhone) {
    throw new Error("Número inválido");
  }

  const fromCrmContact = toCrmJid(fromJid);
  const toCrmContact = toCrmJid(toJid);

  if (!fromCrmContact || !toCrmContact) {
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

  const id_msg = sentMessage?.key?.id || null;

  console.log("📤 Mensaje enviado", {
    source,
    to: toCrmContact,
    id_msg,
    adjunto: Boolean(adjunto),
    message: message.trim(),
    timestamp: getCurrentDateTime(),
    timezone: resolveAppTimeZone(),
  });

  // 💾 Guardar SOLO lo que manda el sistema
  if (process.env.DATABASE === "mysql") {
    await saveMessageMysql(
      fromCrmContact,
      toCrmContact,
      message.trim(),
      null,
      id_msg,
      "",
      id_operador,
    );
  }

  return {
    msg: "Whatsapp Enviado",
    id_msg,
  };
}

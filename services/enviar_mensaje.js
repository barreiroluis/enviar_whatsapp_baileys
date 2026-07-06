import { getSock } from "../whatsapp.js";
import { saveMessageMysql } from "../adapter/mysql.js";
import { cleanNumber, jidToPhone, toCrmJid } from "../utils/cleanNumber.js";
import { getCurrentDateTime } from "../utils/date.js";
import { resolveMediaFromUrl } from "../utils/media.js";
import { resolveAppTimeZone } from "../utils/timezone.js";

export async function enviar_mensaje({
  to,
  message,
  adjunto = null,
  adjunto_tipo = null,
  adjunto_mimetype = null,
  adjunto_nombre = null,
  id_operador = 0, // cron = 0
  source = "system",
  account_key = "default",
}) {
  const sock = getSock(account_key);

  if (!sock || !sock.user) {
    throw new Error(`WhatsApp no conectado (${account_key})`);
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
  let sentMessageText = message.trim();

  // 📎 CON ADJUNTO (URL)
  if (adjunto) {
    const { mediaType, mimetype, fileName } = await resolveMediaFromUrl(adjunto, {
      mediaType: adjunto_tipo,
      mimetype: adjunto_mimetype,
      fileName: adjunto_nombre,
    });

    if (!mediaType) {
      throw new Error("Tipo de adjunto no soportado");
    }

    const payload = {
      [mediaType]: { url: adjunto },
      fileName: mediaType === "document" ? fileName : undefined,
      mimetype: mimetype || undefined,
      caption: message?.trim() || undefined,
    };

    sentMessage = await sock.sendMessage(toJid, payload);
  } else {
    // 📩 SOLO TEXTO
    sentMessage = await sock.sendMessage(toJid, {
      text: sentMessageText,
    });
  }

  const id_msg = sentMessage?.key?.id || null;

  console.log("📤 Mensaje enviado", {
    source,
    account_key,
    to: toCrmContact,
    id_msg,
    adjunto: Boolean(adjunto),
    message: sentMessageText,
    timestamp: getCurrentDateTime(),
    timezone: resolveAppTimeZone(),
  });

  // 💾 Guardar SOLO lo que manda el sistema
  if (process.env.DATABASE === "mysql") {
    await saveMessageMysql(
      fromCrmContact,
      toCrmContact,
      sentMessageText,
      null,
      id_msg,
      "",
      id_operador,
      {
        to_transport_jid: toCrmContact,
        chat_id_context: toCrmContact,
        numero_emisor_context: fromCrmContact,
        account_key_context: account_key,
      },
    );
  }

  return {
    msg: "Whatsapp Enviado",
    id_msg,
    account_key,
    numero_emisor: fromPhone,
  };
}

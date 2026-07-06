import { generateWAMessageFromContent, proto } from "@whiskeysockets/baileys";
import { getSock } from "../whatsapp.js";
import { saveMessageMysql } from "../adapter/mysql.js";
import { cleanNumber, jidToPhone, toCrmJid } from "../utils/cleanNumber.js";
import { getCurrentDateTime } from "../utils/date.js";
import { resolveMediaFromUrl } from "../utils/media.js";
import { resolveAppTimeZone } from "../utils/timezone.js";

function parseInteractiveButtons(input = []) {
  if (!input) return [];
  if (Array.isArray(input)) return input;

  if (typeof input === "string") {
    const cleanInput = input.trim();
    if (!cleanInput) return [];

    try {
      const parsed = JSON.parse(cleanInput);
      return parseInteractiveButtons(parsed);
    } catch {
      return [];
    }
  }

  if (typeof input === "object") {
    if (Array.isArray(input.buttons)) return input.buttons;
    if (Array.isArray(input.items)) return input.items;
    return [input];
  }

  return [];
}

function normalizeInteractiveButtons(input = []) {
  return parseInteractiveButtons(input)
    .map((button, index) => {
      if (!button || typeof button !== "object") return null;

      const type = String(button.type || button.tipo || "").trim().toLowerCase();
      const isCopyButton =
        type === "copy" ||
        type === "copiar" ||
        type === "cta_copy" ||
        button.copy_code != null;
      const isUrlButton =
        type === "url" ||
        type === "link" ||
        type === "enlace" ||
        type === "cta_url" ||
        button.url != null ||
        button.href != null;

      if (!isCopyButton && !isUrlButton) return null;

      const value = isUrlButton
        ? String(button.url ?? button.href ?? button.value ?? "").trim()
        : String(
            button.value ??
              button.copy_code ??
              button.codigo ??
              button.numero_operacion ??
              button.numeroOperacion ??
              button.operation_number ??
              button.operationNumber ??
              "",
          ).trim();

      if (!value) return null;
      if (isUrlButton && !/^https?:\/\//i.test(value)) return null;

      const label = String(
        button.label ??
          button.text ??
          button.display_text ??
          button.displayText ??
          button.buttonText ??
          "",
      )
        .trim()
        .slice(0, 40);

      const buttonType = isUrlButton ? "url" : "copy";
      const safeId = String(button.id || `${buttonType}_${index}_${value}`)
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .slice(0, 80);

      return {
        type: buttonType,
        id: safeId || `${buttonType}_${index}`,
        label: label || (isUrlButton ? "Abrir enlace" : "Copiar"),
        value,
      };
    })
    .filter(Boolean)
    .slice(0, 3);
}

function buildNativeFlowInfo(button) {
  if (button.type === "url") {
    return {
      name: "cta_url",
      buttonParamsJson: JSON.stringify({
        display_text: button.label,
        id: button.id,
        url: button.value,
        merchant_url: button.value,
      }),
    };
  }

  return {
    name: "cta_copy",
    buttonParamsJson: JSON.stringify({
      display_text: button.label,
      id: button.id,
      copy_code: button.value,
    }),
  };
}

function getInteractiveButtonsMode() {
  return String(process.env.WHATSAPP_INTERACTIVE_BUTTONS_MODE || "text")
    .trim()
    .toLowerCase();
}

function shouldTryNativeInteractiveButtons() {
  return ["native", "interactive", "true", "1"].includes(
    getInteractiveButtonsMode(),
  );
}

function appendInteractiveButtonsAsText(message, buttons) {
  const baseMessage = message.trim();
  const missingButtonLines = buttons
    .filter((button) => !baseMessage.includes(button.value))
    .map((button) => `${button.label}: ${button.value}`);

  if (!missingButtonLines.length) return baseMessage;

  return `${baseMessage}\n\nAcciones:\n${missingButtonLines.join("\n")}`;
}

async function enviarMensajeConBotonesInteractivos(sock, toJid, message, buttons) {
  const nativeButtons = buttons.map((button) => buildNativeFlowInfo(button));

  const content = {
    viewOnceMessage: {
      message: {
        messageContextInfo: {
          deviceListMetadata: {},
          deviceListMetadataVersion: 2,
        },
        interactiveMessage: proto.Message.InteractiveMessage.create({
          body: proto.Message.InteractiveMessage.Body.create({
            text: message.trim(),
          }),
          footer: proto.Message.InteractiveMessage.Footer.create({
            text: "Tocá el botón para continuar.",
          }),
          header: proto.Message.InteractiveMessage.Header.create({
            hasMediaAttachment: false,
          }),
          nativeFlowMessage:
            proto.Message.InteractiveMessage.NativeFlowMessage.create({
              buttons: nativeButtons,
              messageVersion: 1,
            }),
        }),
      },
    },
  };

  const waMessage = generateWAMessageFromContent(toJid, content, {
    userJid: sock.user.id,
  });

  await sock.relayMessage(toJid, waMessage.message, {
    messageId: waMessage.key.id,
  });

  return waMessage;
}

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
  interactive_buttons = [],
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
  let interactiveMode = "none";
  const interactiveButtons = !adjunto
    ? normalizeInteractiveButtons(interactive_buttons)
    : [];

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
  } else if (interactiveButtons.length) {
    // Baileys puede aceptar botones nativos y WhatsApp descartarlos sin error.
    // Por defecto priorizamos entregar el texto normal.
    if (shouldTryNativeInteractiveButtons()) {
      try {
        sentMessage = await enviarMensajeConBotonesInteractivos(
          sock,
          toJid,
          message,
          interactiveButtons,
        );
        interactiveMode = "native";
      } catch (error) {
        console.warn(
          "⚠️ No se pudieron enviar botones interactivos. Se envía texto plano.",
          {
            account_key,
            to: toCrmContact,
            botones_interactivos: interactiveButtons.length,
            error: error?.message || String(error),
          },
        );
      }
    }

    if (!sentMessage) {
      sentMessageText = appendInteractiveButtonsAsText(
        message,
        interactiveButtons,
      );
      interactiveMode =
        sentMessageText === message.trim()
          ? "text"
          : "text_with_button_values";
      sentMessage = await sock.sendMessage(toJid, {
        text: sentMessageText,
      });
    }
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
    botones_interactivos: interactiveButtons.length,
    interactive_mode: interactiveMode,
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
    interactive_mode: interactiveMode,
  };
}

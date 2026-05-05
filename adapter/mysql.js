import { getConnectionWithRelease, isMySQL } from "../database.js";
import { getCurrentDateTimeUtc } from "../utils/date.js";
import { logError } from "../utils/logger.js";

export async function saveMessageMysql(
  from,
  to,
  message,
  adjunto,
  id_msg,
  quotedStanzaID = "",
  id_operador = 0,
  context = {},
) {
  if (!isMySQL) {
    return null;
  }

  let connection;

  try {
    const fecha_reg = getCurrentDateTimeUtc();
    const id_empresa = Number(process.env.ID_EMPRESA);

    connection = await getConnectionWithRelease();

    const numeroEmisorContext =
      String(context?.numero_emisor_context || from || "").trim() || null;
    const toTransportJid =
      String(context?.to_transport_jid || to || "").trim() || null;
    const chatIdContext =
      String(context?.chat_id_context || toTransportJid || to || "").trim() ||
      null;
    let idEmisorContext =
      Number(context?.id_emisor_crm_cuentas_context || 0) || null;

    if (!idEmisorContext && numeroEmisorContext) {
      const emitterRows = await connection.query(
        `
          SELECT id
          FROM crm_cuentas
          WHERE id_empresa = ?
            AND numero = ?
          LIMIT 1
        `,
        [id_empresa, numeroEmisorContext],
      );
      idEmisorContext = Number(emitterRows?.[0]?.id || 0) || null;
    }

    const query = `
      INSERT INTO crm_mensajes
      (
        id_empresa,
        id_msg,
        \`from\`,
        \`to\`,
        to_transport_jid,
        chat_id_context,
        id_emisor_crm_cuentas_context,
        numero_emisor_context,
        message,
        adjunto,
        quotedStanzaID,
        id_operador,
        fecha_reg
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        to_transport_jid = COALESCE(VALUES(to_transport_jid), to_transport_jid),
        chat_id_context = COALESCE(VALUES(chat_id_context), chat_id_context),
        id_emisor_crm_cuentas_context = COALESCE(VALUES(id_emisor_crm_cuentas_context), id_emisor_crm_cuentas_context),
        numero_emisor_context = COALESCE(VALUES(numero_emisor_context), numero_emisor_context)
    `;

    const params = [
      id_empresa,
      id_msg,
      from,
      to,
      toTransportJid,
      chatIdContext,
      idEmisorContext,
      numeroEmisorContext,
      message,
      adjunto,
      quotedStanzaID,
      id_operador,
      fecha_reg,
    ];

    return await connection.query(query, params);
  } catch (err) {
    logError("❌ Error al guardar mensaje", err, { id_msg, to });
    return null;
  } finally {
    if (connection) connection.release();
  }
}

import { getConnectionWithRelease, isMySQL } from "../database.js";
import { getCurrentDateTime } from "../utils/date.js";
import { logError } from "../utils/logger.js";

export async function saveMessageMysql(
  from,
  to,
  message,
  adjunto,
  id_msg,
  quotedStanzaID = "",
  id_operador = 0,
) {
  if (!isMySQL) {
    return null;
  }

  let connection;

  try {
    const fecha_reg = getCurrentDateTime();
    const id_empresa = Number(process.env.ID_EMPRESA);

    connection = await getConnectionWithRelease();

    const query = `
      INSERT INTO crm_mensajes
      (id_empresa, id_msg, \`from\`, \`to\`, message, adjunto, quotedStanzaID, id_operador, fecha_reg)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
      id_empresa,
      id_msg,
      from,
      to,
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

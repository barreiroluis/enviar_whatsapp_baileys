import "dotenv/config";

import cron from "node-cron";
import moment from "moment-timezone";

import app from "./server.js";
import { getConnectionWithRelease, initPool } from "./database.js";
import { enviar_mensaje } from "./services/enviar_mensaje.js";
import { getCurrentDateTime } from "./utils/date.js";
import { logError, setupConsoleLogging } from "./utils/logger.js";
import {
  calcularDiasHastaVencimiento,
  describirEstadoVencimiento,
  getDefaultRecordatorioConfig,
  getRecordatorioEventKey,
  isHourAllowed,
  normalizarRecordatorioConfig,
  renderTemplate,
  shouldSendCredit,
} from "./utils/recordatorio.js";
import { resolveAppTimeZone } from "./utils/timezone.js";
import { initWhatsApp, getSock } from "./whatsapp.js";

setupConsoleLogging();

const PORT = process.env.PORT || 3000;
const APP_TIME_ZONE = resolveAppTimeZone();
const ID_EMPRESA = Number(process.env.ID_EMPRESA);

process.env.TZ = APP_TIME_ZONE;

process.on("unhandledRejection", (reason) => {
  const err =
    reason instanceof Error
      ? reason
      : new Error(`UnhandledRejection: ${reason}`);
  logError("UnhandledRejection", err);
});

process.on("uncaughtException", (err) => {
  logError("UncaughtException", err);
});

let cronRunning = false;

cron.schedule(
  "*/30 * * * *",
  async () => {
    const sock = getSock();
    if (cronRunning || !sock?.user) return;

    cronRunning = true;
    try {
      await procesarRecordatoriosCron();
    } finally {
      cronRunning = false;
    }
  },
  { timezone: APP_TIME_ZONE },
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseDbBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (value == null) return false;

  const normalized = String(value).trim().toLowerCase();
  return ["1", "true", "t", "si", "sí", "on", "yes", "y"].includes(normalized);
}

function formatCurrency(value) {
  return Number(value || 0).toLocaleString("es-AR");
}

function formatDateForTemplate(dateValue) {
  if (!dateValue) return "";

  const normalized = moment(dateValue).format("YYYY-MM-DD");
  const parsed = moment.tz(normalized, "YYYY-MM-DD", true, APP_TIME_ZONE);
  return parsed.isValid() ? parsed.format("DD/MM/YYYY") : "";
}

function getResumenUrl(idCredito) {
  return `https://cuotafacil.com/cuotas.php?id=${idCredito}`;
}

function getLegacyTemplateCandidates() {
  return {
    due_3: [
      "• Crédito #{credito_id}\nArtículo(s): {articulos}\nVence en 3 días\nSaldo: ${saldo}\n{resumen_url}",
      "*RECORDATORIO*\n{name}\n\nTenés {cantidad_creditos} crédito(s) para revisar:\n\n• Crédito #{credito_id}\nArtículo(s): {articulos}\nVence en 3 días\nDeuda: ${deuda_total}\n{resumen_url}\n\n*Formas de pago*\n- RapiPago\n- PagoFácil\n- Saldo MercadoPago\n- Transferencia\n{cbu_alias}\n\n📎 Luego de pagar, podés *responder este mensaje con el comprobante*.",
    ],
    due_1: [
      "• Crédito #{credito_id}\nArtículo(s): {articulos}\nVence mañana\nSaldo: ${saldo}\n{resumen_url}",
      "*RECORDATORIO*\n{name}\n\nTenés {cantidad_creditos} crédito(s) para revisar:\n\n• Crédito #{credito_id}\nArtículo(s): {articulos}\nVence mañana\nDeuda: ${deuda_total}\n{resumen_url}\n\n*Formas de pago*\n- RapiPago\n- PagoFácil\n- Saldo MercadoPago\n- Transferencia\n{cbu_alias}\n\n📎 Luego de pagar, podés *responder este mensaje con el comprobante*.",
    ],
    due_0: [
      "• Crédito #{credito_id}\nArtículo(s): {articulos}\nVence hoy\nSaldo: ${saldo}\n{resumen_url}",
      "*RECORDATORIO*\n{name}\n\nTenés {cantidad_creditos} crédito(s) para revisar:\n\n• Crédito #{credito_id}\nArtículo(s): {articulos}\nVence hoy\nDeuda: ${deuda_total}\n{resumen_url}\n\n*Formas de pago*\n- RapiPago\n- PagoFácil\n- Saldo MercadoPago\n- Transferencia\n{cbu_alias}\n\n📎 Luego de pagar, podés *responder este mensaje con el comprobante*.",
    ],
    overdue: [
      "• Crédito #{credito_id}\nArtículo(s): {articulos}\nVencido hace {dias_vencido} días\nSaldo: ${saldo}\n{resumen_url}",
      "*RECORDATORIO*\n{name}\n\nTenés {cantidad_creditos} crédito(s) para revisar:\n\n• Crédito #{credito_id}\nArtículo(s): {articulos}\nVencido hace {dias_vencido} días\nDeuda: ${deuda_total}\n{resumen_url}\n\n*Formas de pago*\n- RapiPago\n- PagoFácil\n- Saldo MercadoPago\n- Transferencia\n{cbu_alias}\n\n📎 Luego de pagar, podés *responder este mensaje con el comprobante*.",
      "Hola {name}, tu crédito #{credito_id} por {articulos} *está vencido hace {dias_vencido} días*.\n\nAbono pendiente: ${deuda_total}\nVer detalle: {resumen_url}\n\n*Formas de pago*\n- RapiPago\n- PagoFácil\n- Saldo MercadoPago\n- Transferencia\n{cbu_alias}\n\n📎 Si ya pagaste, podés responder este mensaje con el comprobante.",
    ],
  };
}

function normalizeTemplateValue(eventKey, templateValue) {
  const defaults = getDefaultRecordatorioConfig().templates.events;
  const currentValue = String(templateValue || "").trim();
  const legacyCandidates = getLegacyTemplateCandidates()[eventKey] || [];

  if (!currentValue || legacyCandidates.includes(currentValue)) {
    return defaults[eventKey]?.template || "";
  }

  return currentValue;
}

async function getRecordatorioConfigForEmpresa(conn, idEmpresa) {
  const empresaRows = await conn.query(
    `
    SELECT cron_recordatorio, nombre, cbu_alias
    FROM empresas
    WHERE id = ?
    LIMIT 1
    `,
    [idEmpresa],
  );

  if (!empresaRows?.length) {
    console.log(`⏸️ Cron omitido: empresa ${idEmpresa} no encontrada`);
    return null;
  }

  const empresa = empresaRows[0];
  let row = {};

  try {
    const configRows = await conn.query(
      `
      SELECT
        start_hour,
        end_hour,
        max_messages_per_run,
        due_3_enabled,
        due_1_enabled,
        due_0_enabled,
        overdue_enabled,
        overdue_first_notice_after_days,
        overdue_repeat_every_days,
        due_3_template,
        due_1_template,
        due_0_template,
        overdue_template
      FROM empresas_recordatorio_config
      WHERE id_empresa = ?
      LIMIT 1
      `,
      [idEmpresa],
    );
    row = configRows?.[0] || {};
  } catch (err) {
    if (err?.code !== "ER_NO_SUCH_TABLE") {
      throw err;
    }
    console.log(
      `ℹ️ Tabla empresas_recordatorio_config inexistente para empresa ${idEmpresa}, usando defaults.`,
    );
  }

  return {
    nombre_empresa: empresa.nombre || "",
    cbu_alias: empresa.cbu_alias || "",
    ...normalizarRecordatorioConfig({
      cron_recordatorio: parseDbBoolean(empresa.cron_recordatorio),
      schedule: {
        start_hour: row.start_hour,
        end_hour: row.end_hour,
      },
      delivery: {
        max_messages_per_run: row.max_messages_per_run,
      },
      templates: {
        events: {
          due_3: {
            enabled: row.due_3_enabled,
            template: normalizeTemplateValue("due_3", row.due_3_template),
          },
          due_1: {
            enabled: row.due_1_enabled,
            template: normalizeTemplateValue("due_1", row.due_1_template),
          },
          due_0: {
            enabled: row.due_0_enabled,
            template: normalizeTemplateValue("due_0", row.due_0_template),
          },
          overdue: {
            enabled: row.overdue_enabled,
            first_notice_after_days: row.overdue_first_notice_after_days,
            repeat_every_days: row.overdue_repeat_every_days,
            template: normalizeTemplateValue("overdue", row.overdue_template),
          },
        },
      },
    }),
  };
}

function buildRecordatorioVariables(row, dias, empresaConfig) {
  const articulos = String(row.articulos || "").trim() || "artículo pendiente";
  const deudaTotal = formatCurrency(row.total_deuda);

  return {
    name: row.nombre || "Cliente",
    empresa: row.nombre_empresa || empresaConfig.nombre_empresa || "",
    cantidad_creditos: "1",
    credito_id: String(row.id_credito),
    articulos,
    saldo: deudaTotal,
    abono: deudaTotal,
    deuda_total: deudaTotal,
    resumen_url: getResumenUrl(row.id_credito),
    fecha_vencimiento: formatDateForTemplate(row.fecha_vencimiento),
    dias_para_vencimiento: dias > 0 ? String(dias) : "0",
    dias_vencido: dias < 0 ? String(Math.abs(dias)) : "0",
    estado_vencimiento: describirEstadoVencimiento(dias),
    cbu_alias: row.cbu_alias || empresaConfig.cbu_alias || "",
  };
}

function generarMensajeDesdePlantilla(row, dias, empresaConfig) {
  const eventKey = getRecordatorioEventKey(dias, empresaConfig);
  const template = empresaConfig.templates.events[eventKey]?.template || "";

  return renderTemplate(
    template,
    buildRecordatorioVariables(row, dias, empresaConfig),
  ).trim();
}

export async function procesarRecordatoriosCron() {
  const ahora = moment.tz(APP_TIME_ZONE);
  const hora = ahora.hour();
  const hoy = ahora.clone().startOf("day").toDate();

  let conn;
  let enviados = 0;
  let creditosNotificados = 0;
  let errores = 0;

  try {
    conn = await getConnectionWithRelease();
    console.log(`[DB] conexión obtenida del pool — ${getCurrentDateTime()}`);

    const empresaConfig = await getRecordatorioConfigForEmpresa(conn, ID_EMPRESA);
    if (!empresaConfig) return;

    if (!empresaConfig.cron_recordatorio) {
      console.log(`⏸️ Cron recordatorio en STOP para empresa ${ID_EMPRESA}`);
      return;
    }

    const unlockResult = await conn.query(
      `
      UPDATE creditos
      SET recordatorio_lock = 0
      WHERE id_empresa = ?
        AND recordatorio_lock = 1
        AND (
          recordatorio_update IS NULL
          OR DATE(recordatorio_update) < CURDATE()
        )
      `,
      [ID_EMPRESA],
    );

    if (unlockResult?.affectedRows > 0) {
      console.log(
        `🧹 Locks liberados empresa ${ID_EMPRESA}: ${unlockResult.affectedRows}`,
      );
    }

    if (
      !isHourAllowed(
        hora,
        empresaConfig.schedule.start_hour,
        empresaConfig.schedule.end_hour,
      )
    ) {
      console.log(
        `⏸️ Cron omitido por horario (${hora}:00) — permitido ${empresaConfig.schedule.start_hour} a ${empresaConfig.schedule.end_hour}`,
      );
      return;
    }

    const rows = await conn.query(
      `
      SELECT
          pe.id AS id_cliente,
          pe.nombre,
          pe.correo,
          pe.celular,
          em.nombre AS nombre_empresa,
          em.cbu_alias,
          cred.id AS id_credito,
          articulos_credito.articulos,
          deuda.fecha_vencimiento,
          deuda.sum_valor AS total_cuotas,
          IFNULL(total_intereses.total_sum, 0) AS total_intereses,
          (deuda.sum_valor + IFNULL(total_intereses.total_sum, 0)) AS total_deuda,
          cred.recordatorio_update
      FROM creditos cred
      INNER JOIN persona pe
          ON cred.id_cliente = pe.id
          AND pe.anunciado_fecha != CURDATE()
      LEFT JOIN empresas em
          ON em.id = pe.id_empresa
      LEFT JOIN (
          SELECT
              art_ven.id_credito,
              GROUP_CONCAT(DISTINCT art.nombre ORDER BY art.nombre SEPARATOR ', ') AS articulos
          FROM articulos_ventidos art_ven
          INNER JOIN articulos art
              ON art_ven.id_articulo = art.id
          WHERE art_ven.devuelto = 0
          GROUP BY art_ven.id_credito
      ) articulos_credito
          ON articulos_credito.id_credito = cred.id
      LEFT JOIN (
          SELECT
              id_credito,
              MIN(fecha_vencimiento) AS fecha_vencimiento,
              SUM(valor) AS sum_valor
          FROM cuotas
          WHERE estado = 0
          GROUP BY id_credito
      ) deuda
          ON deuda.id_credito = cred.id
      LEFT JOIN (
          SELECT
              id_credito,
              SUM(valor) AS total_sum
          FROM cuotas_interes_punitorio
          WHERE pagado = 0
          GROUP BY id_credito
      ) total_intereses
          ON total_intereses.id_credito = cred.id
      WHERE
          cred.anulado = 0
          AND pe.estado NOT IN (5,7,8,9)
          AND cred.fecha_alta != CURDATE()
          AND cred.id_empresa = ?
          AND cred.recordatorio_lock = 0
          AND (
              cred.recordatorio_update IS NULL
              OR DATE(cred.recordatorio_update) < CURDATE()
          )
      GROUP BY cred.id
      HAVING
          deuda.sum_valor > 0
          AND deuda.fecha_vencimiento <= DATE_ADD(CURDATE(), INTERVAL 3 DAY)
      ORDER BY deuda.fecha_vencimiento ASC, cred.id ASC
      `,
      [ID_EMPRESA],
    );

    const creditosParaEnviar = rows
      .map((row) => {
        const dias = calcularDiasHastaVencimiento(
          row.fecha_vencimiento,
          hoy,
          APP_TIME_ZONE,
        );

        if (!Number.isFinite(dias)) return null;
        if (
          !shouldSendCredit({
            row,
            dias,
            config: empresaConfig,
            hoy,
            timeZone: APP_TIME_ZONE,
          })
        ) {
          return null;
        }

        return {
          ...row,
          dias,
          eventKey: getRecordatorioEventKey(dias, empresaConfig),
        };
      })
      .filter(Boolean);

    for (const credito of creditosParaEnviar) {
      if (enviados >= empresaConfig.delivery.max_messages_per_run) {
        console.log(
          `⏹️ Límite de ${empresaConfig.delivery.max_messages_per_run} envíos alcanzado`,
        );
        break;
      }

      try {
        const lockResult = await conn.query(
          `
          UPDATE creditos
          SET recordatorio_lock = 1
          WHERE id = ?
            AND recordatorio_lock = 0
          `,
          [credito.id_credito],
        );

        if (lockResult?.affectedRows !== 1) {
          continue;
        }

        const mensaje = generarMensajeDesdePlantilla(
          credito,
          credito.dias,
          empresaConfig,
        );
        if (!mensaje) {
          await conn.query(
            `
            UPDATE creditos
            SET recordatorio_lock = 0
            WHERE id = ?
            `,
            [credito.id_credito],
          );
          continue;
        }

        const resulEnvio = await enviar_mensaje({
          to: credito.celular,
          message: mensaje,
          id_operador: 0,
          source: "cron",
        });

        await conn.query(
          `
          UPDATE creditos
          SET recordatorio_update = NOW(),
              recordatorio_lock = 0
          WHERE id = ?
          `,
          [credito.id_credito],
        );

        console.log(
          resulEnvio,
          "Crédito:",
          credito.id_credito,
          "Evento:",
          credito.eventKey,
          "Empresa:",
          credito.nombre_empresa,
          "Cliente:",
          credito.nombre,
          "Cel:",
          credito.celular,
        );

        enviados += 1;
        creditosNotificados += 1;
        await sleep(700);
      } catch (err) {
        errores += 1;
        logError(`❌ Error celular ${credito.celular}`, err, {
          credito: credito.id_credito,
          empresa: ID_EMPRESA,
          evento: credito.eventKey,
        });
      }
    }

    console.log(
      `📊 Cron → Empresa ${ID_EMPRESA} | Mensajes: ${enviados} | Créditos notificados: ${creditosNotificados} | Errores: ${errores}`,
    );
  } catch (err) {
    logError("🔥 Error crítico en cron", err, { empresa: ID_EMPRESA });
  } finally {
    if (conn) {
      conn.release();
      console.log(`[DB] conexión liberada al pool — ${getCurrentDateTime()}`);
    }
  }
}

(async () => {
  await initWhatsApp();

  app.listen(PORT, () => {
    console.log(`🚀 API WhatsApp en http://localhost:${PORT}`);
    console.log(`🕒 Zona horaria app: ${APP_TIME_ZONE}`);
    console.log("Server started successfully.");
    initPool();
  });
})();

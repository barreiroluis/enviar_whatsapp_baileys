import "dotenv/config";

import cron from "node-cron";
import moment from "moment-timezone";

import app from "./server.js";
import { getConnectionWithRelease, initPool, isMySQL } from "./database.js";
import { enviar_mensaje } from "./services/enviar_mensaje.js";
import {
  buildDetalleFromCredito,
  createRecordatorioRun,
  ensureRecordatorioAuditSchema,
  finishRecordatorioRun,
  getDailyRecordatorioSummary,
  getDateTimeLocal,
  getFechaLocal,
  getOwnerForEmpresa,
  getOwnerReporte,
  insertRecordatorioDetalle,
  upsertOwnerReporte,
} from "./services/recordatorio_auditoria.js";
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
import { normalizeCustomerPhone } from "./utils/cleanNumber.js";
import { resolveAppTimeZone } from "./utils/timezone.js";
import { initWhatsApp, getSock, getDefaultAccountKey } from "./whatsapp.js";

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
    if (cronRunning) return;

    cronRunning = true;
    try {
      await procesarRecordatoriosCron();
    } finally {
      cronRunning = false;
    }
  },
  { timezone: APP_TIME_ZONE },
);

cron.schedule(
  "5,35 20-23 * * *",
  async () => {
    try {
      await enviarReporteDiarioRecordatoriosOwner();
    } catch (err) {
      logError("❌ Error enviando reporte diario de recordatorios", err, {
        empresa: ID_EMPRESA,
      });
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

function normalizeAccountKey(value = "") {
  const safe = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 80);
  return safe || "";
}

async function resolveNotificationAccountForSucursal(conn, idEmpresa, idSucursal) {
  const defaultKey = getDefaultAccountKey();
  const sucursalId = Number(idSucursal || 0);

  if (sucursalId > 0) {
    try {
      const rows = await conn.query(
        `
        SELECT account_key
        FROM whatsapp_notificacion_cuentas
        WHERE id_empresa = ?
          AND id_sucursal = ?
          AND (fecha_baja IS NULL OR fecha_baja = '0000-00-00 00:00:00')
        ORDER BY es_default ASC, id ASC
        LIMIT 1
        `,
        [idEmpresa, sucursalId],
      );
      const accountKey = normalizeAccountKey(rows?.[0]?.account_key || "");
      if (accountKey) {
        await initWhatsApp(accountKey);
        if (getSock(accountKey)?.user) {
          return { accountKey, source: "sucursal" };
        }
        console.log(
          `⏭️ Cuenta ${accountKey} asignada a sucursal ${sucursalId} no conectada. Usando default.`,
        );
      }
    } catch (err) {
      if (err?.code !== "ER_NO_SUCH_TABLE") {
        logError("❌ Error resolviendo WhatsApp por sucursal", err, {
          idEmpresa,
          idSucursal: sucursalId,
        });
      }
    }
  }

  return { accountKey: defaultKey, source: "default" };
}

function getLegacyTemplateCandidates() {
  return {
    due_3: [
      "• Crédito #{credito_id}\nArtículo(s): {articulos}\nVence en 3 días\nSaldo: ${saldo}\n{resumen_url}",
      "*RECORDATORIO*\n{name}\n\nTenés {cantidad_creditos} crédito(s) para revisar:\n\n• Crédito #{credito_id}\nArtículo(s): {articulos}\nVence en 3 días\nDeuda: ${deuda_total}\n{resumen_url}\n\n*Formas de pago*\n- RapiPago\n- PagoFácil\n- Saldo MercadoPago\n- Transferencia\n{cbu_alias}\n\n📎 Luego de pagar, podés *responder este mensaje con el comprobante*.",
      "Hola {name}, te recordamos que tu crédito #{credito_id} por {articulos} *vence en 3 días*.\n\nAbono pendiente: ${deuda_total}\nVer detalle: {resumen_url}\n\n*Formas de pago*\n- RapiPago\n- PagoFácil\n- Saldo MercadoPago\n- Transferencia\n{cbu_alias}\n\n📎 Si ya pagaste, podés responder este mensaje con el comprobante.",
    ],
    due_1: [
      "• Crédito #{credito_id}\nArtículo(s): {articulos}\nVence mañana\nSaldo: ${saldo}\n{resumen_url}",
      "*RECORDATORIO*\n{name}\n\nTenés {cantidad_creditos} crédito(s) para revisar:\n\n• Crédito #{credito_id}\nArtículo(s): {articulos}\nVence mañana\nDeuda: ${deuda_total}\n{resumen_url}\n\n*Formas de pago*\n- RapiPago\n- PagoFácil\n- Saldo MercadoPago\n- Transferencia\n{cbu_alias}\n\n📎 Luego de pagar, podés *responder este mensaje con el comprobante*.",
      "Hola {name}, te recordamos que tu crédito #{credito_id} por {articulos} *vence mañana*.\n\nAbono pendiente: ${deuda_total}\nVer detalle: {resumen_url}\n\n*Formas de pago*\n- RapiPago\n- PagoFácil\n- Saldo MercadoPago\n- Transferencia\n{cbu_alias}\n\n📎 Si ya pagaste, podés responder este mensaje con el comprobante.",
    ],
    due_0: [
      "• Crédito #{credito_id}\nArtículo(s): {articulos}\nVence hoy\nSaldo: ${saldo}\n{resumen_url}",
      "*RECORDATORIO*\n{name}\n\nTenés {cantidad_creditos} crédito(s) para revisar:\n\n• Crédito #{credito_id}\nArtículo(s): {articulos}\nVence hoy\nDeuda: ${deuda_total}\n{resumen_url}\n\n*Formas de pago*\n- RapiPago\n- PagoFácil\n- Saldo MercadoPago\n- Transferencia\n{cbu_alias}\n\n📎 Luego de pagar, podés *responder este mensaje con el comprobante*.",
      "Hola {name}, te recordamos que tu crédito #{credito_id} por {articulos} *vence hoy*.\n\nValor a pagar para ponerte al día: ${valor_a_pagar}\nVer detalle: {resumen_url}\n\n*Formas de pago*\n- RapiPago\n- PagoFácil\n- Saldo MercadoPago\n- Transferencia\n{cbu_alias}\n\n📎 Si ya pagaste, podés responder este mensaje con el comprobante.",
    ],
    overdue: [
      "• Crédito #{credito_id}\nArtículo(s): {articulos}\nVencido hace {dias_vencido} días\nSaldo: ${saldo}\n{resumen_url}",
      "*RECORDATORIO*\n{name}\n\nTenés {cantidad_creditos} crédito(s) para revisar:\n\n• Crédito #{credito_id}\nArtículo(s): {articulos}\nVencido hace {dias_vencido} días\nDeuda: ${deuda_total}\n{resumen_url}\n\n*Formas de pago*\n- RapiPago\n- PagoFácil\n- Saldo MercadoPago\n- Transferencia\n{cbu_alias}\n\n📎 Luego de pagar, podés *responder este mensaje con el comprobante*.",
      "Hola {name}, tu crédito #{credito_id} por {articulos} *está vencido hace {dias_vencido} días*.\n\nAbono pendiente: ${deuda_total}\nVer detalle: {resumen_url}\n\n*Formas de pago*\n- RapiPago\n- PagoFácil\n- Saldo MercadoPago\n- Transferencia\n{cbu_alias}\n\n📎 Si ya pagaste, podés responder este mensaje con el comprobante.",
      "Hola {name}, tu crédito #{credito_id} por {articulos} *{estado_vencimiento}*.\n\nValor a pagar para ponerte al día: ${valor_a_pagar}\nVer detalle: {resumen_url}\n\n*Formas de pago*\n- RapiPago\n- PagoFácil\n- Saldo MercadoPago\n- Transferencia\n{cbu_alias}\n\n📎 Si ya pagaste, podés responder este mensaje con el comprobante.",
    ],
  };
}

function normalizeTemplateValue(eventKey, templateValue) {
  const defaults = getDefaultRecordatorioConfig().templates.events;
  let currentValue = String(templateValue || "")
    .replaceAll("{abono_al_dia}", "{valor_a_pagar}")
    .replaceAll("{abonos_pendientes}", "{valor_a_pagar}")
    .trim();
  if (eventKey === "due_3" || eventKey === "due_1") {
    currentValue = currentValue.replaceAll(
      "Abono pendiente: ${deuda_total}",
      "Próxima cuota a pagar: ${valor_proxima_cuota}",
    );
  }
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
  const abonoAlDia = formatCurrency(row.total_al_dia);
  const valorProximaCuota = formatCurrency(row.valor_proxima_cuota);

  return {
    name: row.nombre || "Cliente",
    empresa: row.nombre_empresa || empresaConfig.nombre_empresa || "",
    cantidad_creditos: "1",
    credito_id: String(row.id_credito),
    articulos,
    saldo: deudaTotal,
    abono: deudaTotal,
    valor_a_pagar: abonoAlDia,
    valor_proxima_cuota: valorProximaCuota,
    abonos_pendientes: abonoAlDia,
    abono_al_dia: abonoAlDia,
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
  return generarRecordatorioDesdePlantilla(row, dias, empresaConfig).mensaje;
}

function generarRecordatorioDesdePlantilla(row, dias, empresaConfig) {
  const eventKey = getRecordatorioEventKey(dias, empresaConfig);
  const template = empresaConfig.templates.events[eventKey]?.template || "";
  const variables = buildRecordatorioVariables(row, dias, empresaConfig);

  return {
    mensaje: renderTemplate(template, variables).trim(),
    variables,
  };
}

export async function procesarRecordatoriosCron() {
  const ahora = moment.tz(APP_TIME_ZONE);
  const hora = ahora.hour();
  const fechaLocal = getFechaLocal(APP_TIME_ZONE, ahora.toDate());
  const hoy = ahora.clone().startOf("day").toDate();

  let conn;
  let idRun = null;
  let enviados = 0;
  let creditosNotificados = 0;
  let errores = 0;
  let omitidos = 0;
  let candidatosDb = 0;
  let candidatosEnviables = 0;
  let limiteAlcanzado = false;
  let intentosEnvio = 0;
  const pendientesPorCuenta = new Map();
  const cuentasPorSucursal = new Map();

  try {
    conn = await getConnectionWithRelease();
    console.log(`[DB] conexión obtenida del pool — ${getCurrentDateTime()}`);
    await ensureRecordatorioAuditSchema(conn);
    idRun = await createRecordatorioRun(conn, {
      idEmpresa: ID_EMPRESA,
      timeZone: APP_TIME_ZONE,
      now: ahora.toDate(),
    });

    const empresaConfig = await getRecordatorioConfigForEmpresa(conn, ID_EMPRESA);
    if (!empresaConfig) {
      await finishRecordatorioRun(conn, idRun, {
        finished_at: getDateTimeLocal(APP_TIME_ZONE),
        status: "error",
        error_message: `Empresa ${ID_EMPRESA} no encontrada`,
      });
      return;
    }

    if (!empresaConfig.cron_recordatorio) {
      console.log(`⏸️ Cron recordatorio en STOP para empresa ${ID_EMPRESA}`);
      await finishRecordatorioRun(conn, idRun, {
        finished_at: getDateTimeLocal(APP_TIME_ZONE),
        status: "cron_disabled",
      });
      return;
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
      await finishRecordatorioRun(conn, idRun, {
        finished_at: getDateTimeLocal(APP_TIME_ZONE),
        status: "outside_schedule",
      });
      return;
    }

    const rows = await conn.query(
      `
      SELECT
          pe.id AS id_cliente,
          pe.nombre,
          pe.correo,
          pe.celular,
          pe.id_sucursal,
          su.nombre AS nombre_sucursal,
          em.nombre AS nombre_empresa,
          em.cbu_alias,
          cred.id AS id_credito,
          articulos_credito.articulos,
          deuda.fecha_vencimiento,
          deuda.sum_valor AS total_cuotas,
          IFNULL(deuda_al_dia.sum_valor, 0) AS total_cuotas_al_dia,
          IFNULL(total_intereses.total_sum, 0) AS total_intereses,
          (deuda.sum_valor + IFNULL(total_intereses.total_sum, 0)) AS total_deuda,
          (IFNULL(deuda_al_dia.sum_valor, 0) + IFNULL(total_intereses.total_sum, 0)) AS total_al_dia,
          (IFNULL(proxima_cuota.valor_cuota, 0) + IFNULL(proxima_cuota.total_intereses, 0)) AS valor_proxima_cuota,
          cred.recordatorio_update
      FROM creditos cred
      INNER JOIN persona pe
          ON cred.id_cliente = pe.id
          AND (
            pe.anunciado_fecha IS NULL
            OR pe.anunciado_fecha != CURDATE()
          )
      LEFT JOIN empresas em
          ON em.id = pe.id_empresa
      LEFT JOIN sucursales su
          ON su.id = pe.id_sucursal
          AND su.id_empresa = pe.id_empresa
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
              SUM(valor) AS sum_valor
          FROM cuotas
          WHERE estado = 0
            AND fecha_vencimiento <= CURDATE()
          GROUP BY id_credito
      ) deuda_al_dia
          ON deuda_al_dia.id_credito = cred.id
      LEFT JOIN (
          SELECT
              id_credito,
              SUM(valor) AS total_sum
          FROM cuotas_interes_punitorio
          WHERE pagado = 0
          GROUP BY id_credito
      ) total_intereses
          ON total_intereses.id_credito = cred.id
      LEFT JOIN (
          SELECT
              cuo.id_credito,
              cuo.id AS id_cuota,
              cuo.valor AS valor_cuota,
              IFNULL(intereses.total_sum, 0) AS total_intereses
          FROM cuotas cuo
          LEFT JOIN (
              SELECT
                  id_cuota,
                  SUM(valor) AS total_sum
              FROM cuotas_interes_punitorio
              WHERE pagado = 0
              GROUP BY id_cuota
          ) intereses
              ON intereses.id_cuota = cuo.id
          WHERE cuo.estado = 0
            AND NOT EXISTS (
                SELECT 1
                FROM cuotas prev
                WHERE prev.id_credito = cuo.id_credito
                  AND prev.estado = 0
                  AND (
                      prev.fecha_vencimiento < cuo.fecha_vencimiento
                      OR (
                          prev.fecha_vencimiento = cuo.fecha_vencimiento
                          AND prev.id < cuo.id
                      )
                  )
            )
      ) proxima_cuota
          ON proxima_cuota.id_credito = cred.id
      WHERE
          cred.anulado = 0
          AND pe.estado NOT IN (5,7,8,9)
          AND cred.fecha_alta != CURDATE()
          AND cred.id_empresa = ?
          AND (
              cred.recordatorio_update IS NULL
              OR DATE(cred.recordatorio_update) < CURDATE()
          )
      GROUP BY cred.id
      HAVING
          deuda.sum_valor > 0
          AND deuda.fecha_vencimiento <= DATE_ADD(CURDATE(), INTERVAL 3 DAY)
      ORDER BY
          CASE
              WHEN deuda.fecha_vencimiento = CURDATE() THEN 0
              WHEN deuda.fecha_vencimiento = DATE_ADD(CURDATE(), INTERVAL 1 DAY) THEN 1
              WHEN deuda.fecha_vencimiento = DATE_ADD(CURDATE(), INTERVAL 3 DAY) THEN 2
              WHEN deuda.fecha_vencimiento < CURDATE()
                   AND cred.recordatorio_update IS NULL THEN 3
              WHEN deuda.fecha_vencimiento < CURDATE() THEN 4
              ELSE 5
          END ASC,
          CASE
              WHEN deuda.fecha_vencimiento < CURDATE()
                   AND cred.recordatorio_update IS NULL THEN deuda.fecha_vencimiento
              ELSE NULL
          END DESC,
          CASE
              WHEN deuda.fecha_vencimiento < CURDATE()
                   AND cred.recordatorio_update IS NOT NULL THEN cred.recordatorio_update
              ELSE NULL
          END ASC,
          deuda.fecha_vencimiento ASC,
          cred.id ASC
      `,
      [ID_EMPRESA],
    );

    candidatosDb = rows.length;
    const creditosParaEnviar = [];

    for (const row of rows) {
      const dias = calcularDiasHastaVencimiento(
        row.fecha_vencimiento,
        hoy,
        APP_TIME_ZONE,
      );

      if (!Number.isFinite(dias)) {
        omitidos += 1;
        await insertRecordatorioDetalle(
          conn,
          buildDetalleFromCredito({
            idRun,
            idEmpresa: ID_EMPRESA,
            credito: { ...row, dias: null },
            evento: "none",
            estado: "omitido",
            motivo: "fecha_vencimiento_invalida",
          }),
        );
        continue;
      }

      const eventKey = getRecordatorioEventKey(dias, empresaConfig);
      const creditoConDias = { ...row, dias, eventKey };
      const shouldSend = shouldSendCredit({
        row,
        dias,
        config: empresaConfig,
        hoy,
        timeZone: APP_TIME_ZONE,
      });

      if (!shouldSend) {
        omitidos += 1;
        await insertRecordatorioDetalle(
          conn,
          buildDetalleFromCredito({
            idRun,
            idEmpresa: ID_EMPRESA,
            credito: creditoConDias,
            evento: eventKey || "none",
            estado: "omitido",
            motivo: eventKey
              ? "frecuencia_o_regla_no_cumplida"
              : "evento_deshabilitado_o_sin_evento",
          }),
        );
        continue;
      }

      const celularNormalizado = normalizeCustomerPhone(row.celular);
      if (!celularNormalizado) {
        omitidos += 1;
        await insertRecordatorioDetalle(conn, buildDetalleFromCredito({
          idRun,
          idEmpresa: ID_EMPRESA,
          credito: creditoConDias,
          evento: eventKey,
          estado: "omitido",
          motivo: String(row.celular ?? "").trim() ? "celular_invalido" : "sin_celular",
          fechaLocal,
        }));
        continue;
      }

      creditosParaEnviar.push({ ...creditoConDias, celularNormalizado });
    }

    candidatosEnviables = creditosParaEnviar.length;

    for (const credito of creditosParaEnviar) {
      let accountKey;
      let despachoIniciado = false;
      const envioKey = [ID_EMPRESA, credito.id_credito, fechaLocal];
      const eventoPendiente = `${credito.eventKey}:${moment(credito.fecha_vencimiento).format("YYYY-MM-DD")}`;
      const registrar = (estado, motivo, extra = {}) =>
        insertRecordatorioDetalle(conn, buildDetalleFromCredito({
          idRun,
          idEmpresa: ID_EMPRESA,
          credito,
          evento: credito.eventKey,
          estado,
          motivo,
          fechaLocal,
          accountKey,
          ...extra,
        }));
      const registrarDesconexion = async () => {
        pendientesPorCuenta.set(accountKey, (pendientesPorCuenta.get(accountKey) || 0) + 1);
        await registrar("candidato", "whatsapp_desconectado");
      };

      try {
        const mensaje = generarRecordatorioDesdePlantilla(credito, credito.dias, empresaConfig).mensaje;
        if (!mensaje) {
          omitidos += 1;
          await registrar("omitido", "plantilla_vacia");
          continue;
        }

        const [envioAnterior] = await conn.query(
          `SELECT id_msg, creado_en <= NOW() - INTERVAL 30 MINUTE AS vencido
           FROM recordatorio_cron_envios
           WHERE id_empresa = ? AND id_credito = ?
             AND (fecha_local = ? OR evento_pendiente = ?)
           ORDER BY id_msg IS NULL DESC LIMIT 1`,
          [...envioKey, eventoPendiente],
        );
        if (envioAnterior) {
          if (!envioAnterior.id_msg && envioAnterior.vencido) {
            errores += 1;
            await registrar("error", "resultado_incierto");
          }
          continue;
        }

        const sucursal = Number(credito.id_sucursal || 0);
        if (!cuentasPorSucursal.has(sucursal)) {
          const cuenta = await resolveNotificationAccountForSucursal(conn, ID_EMPRESA, sucursal);
          cuentasPorSucursal.set(sucursal, cuenta.accountKey);
        }
        accountKey = cuentasPorSucursal.get(sucursal);
        if (!getSock(accountKey)?.user) {
          await registrarDesconexion();
          continue;
        }

        if (intentosEnvio >= empresaConfig.delivery.max_messages_per_run) {
          limiteAlcanzado = true;
          await registrar("candidato", "limite_por_corrida_alcanzado");
          continue;
        }

        try {
          await conn.query(
            `INSERT INTO recordatorio_cron_envios (id_empresa, id_credito, fecha_local, evento_pendiente)
             VALUES (?, ?, ?, ?)`,
            [...envioKey, eventoPendiente],
          );
        } catch (err) {
          if (err?.code === "ER_DUP_ENTRY") continue;
          throw err;
        }

        despachoIniciado = true;
        intentosEnvio += 1;
        const resultado = await enviar_mensaje({
          to: credito.celularNormalizado,
          message: mensaje,
          id_operador: 0,
          source: "cron",
          account_key: accountKey,
        });
        if (!resultado.id_msg) throw new Error("WhatsApp no devolvió un ID de mensaje");

        await conn.query("START TRANSACTION");
        try {
          await conn.query(
            `UPDATE creditos SET recordatorio_update = NOW(), recordatorio_lock = 0
             WHERE id = ? AND id_empresa = ?`,
            [credito.id_credito, ID_EMPRESA],
          );
          await registrar("enviado", "enviado", {
            idMsg: resultado.id_msg,
            numeroEmisor: resultado.numero_emisor,
          });
          await conn.query(
            `UPDATE recordatorio_cron_envios SET id_msg = ?, evento_pendiente = NULL
             WHERE id_empresa = ? AND id_credito = ? AND fecha_local = ?`,
            [resultado.id_msg, ...envioKey],
          );
          await conn.query("COMMIT");
        } catch (err) {
          await conn.query("ROLLBACK");
          throw err;
        }
        enviados += 1;
        creditosNotificados += 1;
        await sleep(700);
      } catch (err) {
        if (despachoIniciado && err?.code === "WHATSAPP_DISCONNECTED") {
          await conn.query(
            `DELETE FROM recordatorio_cron_envios
             WHERE id_empresa = ? AND id_credito = ? AND fecha_local = ?`,
            envioKey,
          );
          await registrarDesconexion();
          continue;
        }

        errores += 1;
        await registrar("error", despachoIniciado ? "resultado_incierto" : "error_envio");
        logError("Error procesando recordatorio", err, {
          credito: credito.id_credito,
          empresa: ID_EMPRESA,
          evento: credito.eventKey,
          accountKey,
        });
        if (despachoIniciado) await sleep(700);
      }
    }

    for (const [accountKey, pendientes] of pendientesPorCuenta) {
      console.warn(`WhatsApp desconectado (${accountKey}): ${pendientes} recordatorios pendientes`);
    }

    console.log(
      `📊 Cron → Empresa ${ID_EMPRESA} | Mensajes: ${enviados} | Créditos notificados: ${creditosNotificados} | Errores: ${errores}`,
    );
    await finishRecordatorioRun(conn, idRun, {
      finished_at: getDateTimeLocal(APP_TIME_ZONE),
      status:
        errores > 0
          ? enviados > 0
            ? "partial_error"
            : "error"
          : pendientesPorCuenta.size && enviados === 0
            ? "whatsapp_disconnected"
            : "ok",
      candidatos_db: candidatosDb,
      candidatos_enviables: candidatosEnviables,
      enviados,
      errores,
      omitidos,
      limite_alcanzado: limiteAlcanzado,
    });
  } catch (err) {
    if (conn && idRun) {
      try {
        await finishRecordatorioRun(conn, idRun, {
          finished_at: getDateTimeLocal(APP_TIME_ZONE),
          status: "error",
          candidatos_db: candidatosDb,
          candidatos_enviables: candidatosEnviables,
          enviados,
          errores: errores + 1,
          omitidos,
          limite_alcanzado: limiteAlcanzado,
          error_message: err?.message || String(err),
        });
      } catch (auditErr) {
        logError("❌ Error cerrando auditoría de recordatorio", auditErr, {
          empresa: ID_EMPRESA,
          run: idRun,
        });
      }
    }
    logError("🔥 Error crítico en cron", err, { empresa: ID_EMPRESA });
  } finally {
    if (conn) {
      conn.release();
      console.log(`[DB] conexión liberada al pool — ${getCurrentDateTime()}`);
    }
  }
}

function toInt(value) {
  return Number(value || 0) || 0;
}

function getEventTotal(summary, eventKey) {
  const row = (summary.eventos || []).find((item) => item.evento === eventKey);
  return toInt(row?.total);
}

function buildReporteDiarioRecordatoriosMessage({
  nombreEmpresa,
  fechaLocal,
  summary,
}) {
  const errores = toInt(summary.errores);
  const enviados = toInt(summary.enviados);
  const candidatos = toInt(summary.candidatos_db);
  const omitidos = toInt(summary.omitidos);
  const status = String(summary.ultimo_status || "sin_corridas");
  const limite = toInt(summary.limite_alcanzado) > 0 ? "Sí" : "No";
  const estadoGeneral =
    errores > 0 || ["error", "partial_error", "whatsapp_disconnected"].includes(status)
      ? "Con alertas"
      : "OK";

  const lines = [
    `📊 *Reporte diario de recordatorios - ${nombreEmpresa || `Empresa ${ID_EMPRESA}`}*`,
    "",
    `📅 Fecha: ${fechaLocal}`,
    `🔎 Candidatos detectados: ${candidatos}`,
    `✅ Enviados: ${enviados}`,
    `⏭️ Omitidos: ${omitidos}`,
    `⚠️ Errores: ${errores}`,
    `⏹️ Límite alcanzado: ${limite}`,
    "",
    "*Eventos enviados*",
    `• Vence en 3 días: ${getEventTotal(summary, "due_3")}`,
    `• Vence mañana: ${getEventTotal(summary, "due_1")}`,
    `• Vence hoy: ${getEventTotal(summary, "due_0")}`,
    `• Vencidos: ${getEventTotal(summary, "overdue")}`,
    "",
    `Estado: *${estadoGeneral}*`,
  ];

  if (summary.ultima_ejecucion) {
    lines.push(`Última ejecución: ${moment(summary.ultima_ejecucion).format("YYYY-MM-DD HH:mm:ss")}`);
  }

  const erroresDetalle = summary.errores_detalle || [];
  if (erroresDetalle.length) {
    lines.push("", "*Últimos errores*");
    for (const item of erroresDetalle) {
      const credito = item.id_credito ? `Crédito ${item.id_credito}` : "Crédito sin id";
      const cliente = item.nombre_cliente ? ` - ${item.nombre_cliente}` : "";
      const motivo = item.error_message || item.motivo || "Error sin detalle";
      lines.push(`• ${credito}${cliente}: ${motivo}`);
    }
  }

  return lines.join("\n");
}

export async function enviarReporteDiarioRecordatoriosOwner() {
  let conn;
  const fechaLocal = getFechaLocal(APP_TIME_ZONE);

  try {
    conn = await getConnectionWithRelease();
    await ensureRecordatorioAuditSchema(conn);

    const existing = await getOwnerReporte(conn, ID_EMPRESA, fechaLocal);
    if (existing?.estado === "enviado") {
      console.log(
        `ℹ️ Reporte diario de recordatorios ya enviado empresa ${ID_EMPRESA} fecha ${fechaLocal}`,
      );
      return;
    }

    const owner = await getOwnerForEmpresa(conn, ID_EMPRESA);
    const celularOwner = String(owner?.celular || "").trim();
    if (!celularOwner) {
      await upsertOwnerReporte(conn, {
        id_empresa: ID_EMPRESA,
        fecha_local: fechaLocal,
        estado: "sin_owner",
        error_message: "Empresa sin owner/celular válido",
      });
      return;
    }

    const summary = await getDailyRecordatorioSummary(conn, ID_EMPRESA, fechaLocal);
    const mensaje = buildReporteDiarioRecordatoriosMessage({
      nombreEmpresa: owner?.nombre_empresa,
      fechaLocal,
      summary,
    });

    if (!getSock()?.user) {
      await upsertOwnerReporte(conn, {
        id_empresa: ID_EMPRESA,
        fecha_local: fechaLocal,
        celular_owner: celularOwner,
        estado: "error",
        resumen: mensaje,
        error_message: "WhatsApp no conectado",
      });
      return;
    }

    const result = await enviar_mensaje({
      to: celularOwner,
      message: mensaje,
      id_operador: 0,
      source: "cron-report",
    });

    await upsertOwnerReporte(conn, {
      id_empresa: ID_EMPRESA,
      fecha_local: fechaLocal,
      celular_owner: celularOwner,
      estado: "enviado",
      id_msg: result?.id_msg,
      account_key: result?.account_key || getDefaultAccountKey(),
      numero_emisor: result?.numero_emisor,
      resumen: mensaje,
      sent_at: getDateTimeLocal(APP_TIME_ZONE),
    });
  } catch (err) {
    if (conn) {
      try {
        await upsertOwnerReporte(conn, {
          id_empresa: ID_EMPRESA,
          fecha_local: fechaLocal,
          estado: "error",
          error_message: err?.message || String(err),
        });
      } catch (auditErr) {
        logError("❌ Error guardando estado de reporte diario", auditErr, {
          empresa: ID_EMPRESA,
        });
      }
    }
    throw err;
  } finally {
    if (conn) conn.release();
  }
}

async function ensureRecordatorioAuditSchemaOnStartup() {
  if (!isMySQL) return;

  let conn;
  try {
    conn = await getConnectionWithRelease();
    await ensureRecordatorioAuditSchema(conn);
    console.log("✅ Auditoría de recordatorios lista.");
  } catch (err) {
    logError("❌ No se pudo preparar auditoría de recordatorios", err, {
      empresa: ID_EMPRESA,
    });
  } finally {
    if (conn) conn.release();
  }
}

(async () => {
  await initWhatsApp();

  app.listen(PORT, () => {
    console.log(`🚀 API WhatsApp en http://localhost:${PORT}`);
    console.log(`🕒 Zona horaria app: ${APP_TIME_ZONE}`);
    console.log("Server started successfully.");
    initPool();
    ensureRecordatorioAuditSchemaOnStartup();
  });
})();

// ⚠️ dotenv primero
import "dotenv/config";

import app from "./server.js";
import { initWhatsApp, getSock } from "./whatsapp.js";
import { enviar_mensaje } from "./services/enviar_mensaje.js";

import cron from "node-cron";
import moment from "moment-timezone";
import { getConnectionWithRelease, initPool } from "./database.js";
import {
  agruparCreditosPorCelular,
  describirEstadoVencimiento,
  heredoc,
  isHourAllowed,
} from "./utils/recordatorio.js";
import { logError, setupConsoleLogging } from "./utils/logger.js";
import { getCurrentDateTime } from "./utils/date.js";
import { resolveAppTimeZone } from "./utils/timezone.js";

setupConsoleLogging();

const PORT = process.env.PORT || 3000;
const APP_TIME_ZONE = resolveAppTimeZone();
process.env.TZ = APP_TIME_ZONE;
const CRON_START_HOUR = Number(process.env.CRON_START_HOUR ?? 9);
const CRON_END_HOUR = Number(process.env.CRON_END_HOUR ?? 20);
const ID_EMPRESA = Number(process.env.ID_EMPRESA);
const PROMO_FIN_DATE_UTC = Date.UTC(2026, 2, 1); // 2026-03-01 (exclusivo)

function dateToUtcMidnight(date) {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function isSuperPromoVigente(date = new Date()) {
  return dateToUtcMidnight(date) < PROMO_FIN_DATE_UTC;
}

function getSuperPromoCountdownText(date = new Date()) {
  if (!isSuperPromoVigente(date)) return null;

  const diasRestantes = Math.floor(
    (PROMO_FIN_DATE_UTC - dateToUtcMidnight(date)) / 86400000,
  );

  const mensajes = {
    10: "⏳ Faltan 10 días para aprovechar la Super Promo (vence el 28/02/2026).",
    5: "⏳ Faltan 5 días para aprovechar la Super Promo (vence el 28/02/2026).",
    3: "⏳ Faltan 3 días para aprovechar la Super Promo (vence el 28/02/2026).",
    2: "⏳ Faltan 2 días para aprovechar la Super Promo (vence el 28/02/2026).",
    1: "⚠️ Último día para aprovechar la Super Promo (vence hoy 28/02/2026).",
  };

  return mensajes[diasRestantes] ?? null;
}

function esCreditoElegibleSuperPromo({ dias, total_deuda, id_empresa }) {
  return (
    id_empresa === 1 &&
    isSuperPromoVigente() &&
    dias <= -20 &&
    Number(total_deuda || 0) >= 200000
  );
}

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

// 🕒 CRON cada 30 minutos
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

function generarMensaje({
  nombre,
  dias,
  id_credito,
  total_deuda,
  fecha_vencimiento,
  id_empresa,
  cbu_alias = null, // 👈 como en PHP
}) {
  const link = `https://cuotafacil.com/cuotas.php?id=${id_credito}`;

  const formasPago = heredoc`
    *Formas de pago*
    - RapiPago
    - PagoFácil
    - Saldo MercadoPago
    - Transferencia
    ${cbu_alias || ""}

    📎 Luego de pagar, podés *responder este mensaje con el comprobante*.
  `;

  // 🔴 VENCIDO
  if (dias < 0) {
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);

    const fechaVenc = new Date(fecha_vencimiento);
    fechaVenc.setHours(0, 0, 0, 0);

    const diasVencido = Math.floor((hoy - fechaVenc) / 86400000);

    // 🔥 PROMO CANCELATORIA (solo empresa 1, hasta 28/02/2026)
    if (
      esCreditoElegibleSuperPromo({
        dias: -diasVencido,
        total_deuda,
        id_empresa,
      })
    ) {
      const promo = Math.round(total_deuda / 2);
      const countdownPromo = getSuperPromoCountdownText();

      return heredoc`
        *SUPER PROMO CANCELATORIO* 🥳
        ${nombre}
        Cancelá tu cuenta con el *50% de la deuda total*

        💰 Deuda actual: $${total_deuda.toLocaleString("es-AR")}
        🔥 Promo cancelatoria: $${promo.toLocaleString("es-AR")}

        Transferí $${promo.toLocaleString("es-AR")}
        Alias: *LevsuMuebles.mp*

        🔒 _No se reciben pagos parciales para aplicar a la promoción_
        ${countdownPromo ? `\n${countdownPromo}` : ""}

        👉 Ver resumen:
        ${link}
      `;
    }

    // 🔴 VENCIDO NORMAL
    return heredoc`
      *CUOTA VENCIDA* 🚨
      ${nombre}

      Tu cuota se encuentra vencida.

      ${formasPago}

      👉 Ver resumen:
      ${link}
    `;
  }

  // 🟠 HOY
  if (dias === 0) {
    return heredoc`
      *RECORDATORIO*
      ${nombre}
      Tu cuota vence *HOY* 👀

      ${formasPago}

      👉 Ver resumen:
      ${link}
    `;
  }

  // 🟡 MAÑANA
  if (dias === 1) {
    return heredoc`
      *RECORDATORIO*
      ${nombre}
      Tu cuota vence *mañana* 😅

      ${formasPago}

      👉 Ver resumen:
      ${link}
    `;
  }

  // 🟢 FUTURO (2–5 días)
  return heredoc`
    *RECORDATORIO*
    ${nombre}
    Tu cuota vence en ${dias} días 🙂

    ${formasPago}

    👉 Ver resumen:
    ${link}
  `;
}

function generarMensajeAgrupado({
  nombre,
  creditos,
  cbu_alias = null,
  id_empresa,
}) {
  const formasPago = heredoc`
    *Formas de pago*
    - RapiPago
    - PagoFácil
    - Saldo MercadoPago
    - Transferencia
    ${cbu_alias || ""}

    📎 Luego de pagar, podés *responder este mensaje con el comprobante*.
  `;

  const resumenCreditos = creditos
    .map((credito) => {
      const link = `https://cuotafacil.com/cuotas.php?id=${credito.id_credito}`;
      const articulos = String(credito.articulos || "").trim();

      return [
        `• Crédito #${credito.id_credito}`,
        articulos ? `Artículo(s): ${articulos}` : null,
        describirEstadoVencimiento(credito.dias),
        `Deuda: $${Number(credito.total_deuda || 0).toLocaleString("es-AR")}`,
        link,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

  const creditosPromo = creditos.filter((credito) =>
    esCreditoElegibleSuperPromo({
      dias: credito.dias,
      total_deuda: credito.total_deuda,
      id_empresa,
    }),
  );

  const countdownPromo = getSuperPromoCountdownText();
  const bloquePromo =
    creditosPromo.length > 0 && countdownPromo
      ? heredoc`
          *SUPER PROMO CANCELATORIO* 🥳
          ${countdownPromo}
        `
      : "";

  return heredoc`
    *RECORDATORIO*
    ${nombre}

    Tenés ${creditos.length} crédito(s) para revisar:

    ${resumenCreditos}
    ${bloquePromo ? `\n${bloquePromo}` : ""}

    ${formasPago}
  `;
}

function parseDbBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (value == null) return false;

  const normalized = String(value).trim().toLowerCase();
  return ["1", "true", "t", "si", "sí", "on", "yes", "y"].includes(normalized);
}

async function isCronRecordatorioEnabledForEmpresa(conn, idEmpresa) {
  const rows = await conn.query(
    `
    SELECT cron_recordatorio
    FROM empresas
    WHERE id = ?
    LIMIT 1
    `,
    [idEmpresa],
  );

  if (!rows?.length) {
    console.log(`⏸️ Cron omitido: empresa ${idEmpresa} no encontrada`);
    return false;
  }

  return parseDbBoolean(rows[0].cron_recordatorio);
}

/**
 * Ejecutar desde cron cada 30 minutos
 */
export async function procesarRecordatoriosCron() {
  const ahora = moment.tz(APP_TIME_ZONE);
  const hora = ahora.hour(); // 0–23

  let conn;
  const hoy = ahora.clone().startOf("day").toDate();
  const diaSemana = ahora.day(); // 0=Domingo
  const LIMITE_ENVIO = 25;

  let enviados = 0;
  let creditosNotificados = 0;
  let errores = 0;

  try {
    conn = await getConnectionWithRelease();
    console.log(`[DB] conexión obtenida del pool — ${getCurrentDateTime()}`);

    const cronRecordatorioEnabled = await isCronRecordatorioEnabledForEmpresa(
      conn,
      ID_EMPRESA,
    );

    if (!cronRecordatorioEnabled) {
      console.log(`⏸️ Cron recordatorio en STOP para empresa ${ID_EMPRESA}`);
      return;
    }

    // 🧹 Limpieza de locks huérfanos para evitar bloqueos permanentes
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

    // ⛔ Restricción horaria configurable
    if (!isHourAllowed(hora, CRON_START_HOUR, CRON_END_HOUR)) {
      console.log(
        `⏸️ Cron omitido por horario (${hora}:00) — permitido ${CRON_START_HOUR} a ${CRON_END_HOUR}`,
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
          em.nombre as nombre_empresa,	 
          em.cbu_alias,	    
          cred.id AS id_credito,
          articulos_credito.articulos,
          deuda.fecha_vencimiento,
          deuda.sum_valor AS total_cuotas,
          IFNULL(total_intereses.total_sum, 0) AS total_intereses,
          (deuda.sum_valor + IFNULL(total_intereses.total_sum, 0)) AS total_deuda
      FROM creditos cred 
      INNER JOIN persona pe 
          ON cred.id_cliente = pe.id 
          AND pe.anunciado_fecha != CURDATE()
      left join empresas em on em.id = pe.id_empresa

      LEFT JOIN (
          SELECT
              art_ven.id_credito,
              GROUP_CONCAT(DISTINCT art.nombre ORDER BY art.nombre SEPARATOR ', ') AS articulos
          FROM articulos_ventidos art_ven
          INNER JOIN articulos art ON art_ven.id_articulo = art.id
          WHERE art_ven.devuelto = 0
          GROUP BY art_ven.id_credito
      ) articulos_credito ON articulos_credito.id_credito = cred.id

      LEFT JOIN (
          SELECT 
              id_credito, 
              MIN(fecha_vencimiento) AS fecha_vencimiento,
              SUM(valor) AS sum_valor
          FROM cuotas
          WHERE estado = 0
          GROUP BY id_credito
      ) deuda ON deuda.id_credito = cred.id
      LEFT JOIN (
          SELECT 
              id_credito,
              SUM(valor) AS total_sum
          FROM cuotas_interes_punitorio
          WHERE pagado = 0
          GROUP BY id_credito
      ) total_intereses ON total_intereses.id_credito = cred.id
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
          AND deuda.fecha_vencimiento <= DATE_ADD(CURDATE(), INTERVAL 5 DAY)
      ORDER BY deuda.fecha_vencimiento ASC
      `,
      [ID_EMPRESA],
    );

    const gruposPorCelular = agruparCreditosPorCelular({
      rows,
      hoy,
      diaSemana,
      timeZone: APP_TIME_ZONE,
    });

    for (const grupo of gruposPorCelular.values()) {
      if (enviados >= LIMITE_ENVIO) {
        console.log(`⏹️ Límite de ${LIMITE_ENVIO} envíos alcanzado`);
        break;
      }

      const creditosLockeados = [];

      for (const credito of grupo.creditos) {
        const lockResult = await conn.query(
          `
          UPDATE creditos
          SET recordatorio_lock = 1
          WHERE id = ?
            AND recordatorio_lock = 0
          `,
          [credito.id_credito],
        );

        if (lockResult.affectedRows === 1) {
          creditosLockeados.push(credito);
        }
      }

      if (!creditosLockeados.length) continue;

      try {
        const mensaje = generarMensajeAgrupado({
          nombre: grupo.nombre,
          creditos: creditosLockeados,
          cbu_alias: grupo.cbu_alias,
          id_empresa: ID_EMPRESA,
        });

        let resul_envio = await enviar_mensaje({
          to: grupo.celular,
          message: mensaje,
          id_operador: 0, // cron
          source: "cron",
        });

        const idsNotificados = creditosLockeados.map((c) => c.id_credito);

        await conn.query(
          `
          UPDATE creditos
          SET recordatorio_update = NOW(),
              recordatorio_lock = 0
          WHERE id IN (?)
          `,
          [idsNotificados],
        );

        console.log(
          resul_envio,
          "Créditos:",
          idsNotificados.join(","),
          "Empresa:",
          grupo.nombre_empresa,
          "Cliente:",
          grupo.nombre,
          "Cel:",
          grupo.celular,
        );

        enviados++;
        creditosNotificados += idsNotificados.length;
        await sleep(700);
      } catch (err) {
        errores++;
        logError(`❌ Error celular ${grupo.celular}`, err, {
          creditos: creditosLockeados.map((c) => c.id_credito),
          empresa: ID_EMPRESA,
        });
        // NO liberar → evita duplicados
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

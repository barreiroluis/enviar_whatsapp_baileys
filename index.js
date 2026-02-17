// 🔇 Filtro global de logs ruidosos de Baileys / Signal
const originalLog = console.log;

console.log = (...args) => {
  const msg = args.join(" ");

  if (
    msg.includes("Closing session") ||
    msg.includes("SessionEntry") ||
    msg.includes("pendingPreKey") ||
    msg.includes("remoteIdentityKey") ||
    msg.includes("baseKeyType")
  ) {
    return;
  }

  originalLog(...args);
};

// ⚠️ dotenv primero
import "dotenv/config";

import app from "./server.js";
import { initWhatsApp, getSock } from "./whatsapp.js";
import { enviar_mensaje } from "./services/enviar_mensaje.js";

import cron from "node-cron";
import { getConnectionWithRelease } from "./database.js";
import { logError } from "./utils/logger.js";

const PORT = process.env.PORT || 3000;
process.env.TZ = process.env.TZ || "UTC";
const CRON_START_HOUR = Number(process.env.CRON_START_HOUR ?? 9);
const CRON_END_HOUR = Number(process.env.CRON_END_HOUR ?? 20);
const ID_EMPRESA = Number(process.env.ID_EMPRESA);

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
cron.schedule("*/30 * * * *", async () => {
  const sock = getSock();

  if (cronRunning || !sock?.user) return;

  cronRunning = true;
  try {
    await procesarRecordatoriosCron();
  } finally {
    cronRunning = false;
  }
});

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

  const formasPago = cbu_alias
    ? heredoc`
        *Formas de pago*
        - RapiPago
        - PagoFácil
        - Saldo MercadoPago
        - Transferencia
        ${cbu_alias}

        📎 Luego de pagar, podés *responder este mensaje con el comprobante*.
      `
    : heredoc`
        *Formas de pago*
        - RapiPago
        - PagoFácil
        - Saldo MercadoPago
      `;

  // 🔴 VENCIDO
  if (dias < 0) {
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);

    const fechaVenc = new Date(fecha_vencimiento);
    fechaVenc.setHours(0, 0, 0, 0);

    const diasVencido = Math.floor((hoy - fechaVenc) / 86400000);

    // 🔥 PROMO CANCELATORIA (solo empresa 1)
    if (id_empresa === 1 && diasVencido >= 20 && total_deuda >= 200000) {
      const promo = Math.round(total_deuda / 2);

      return heredoc`
        *SUPER PROMO CANCELATORIO* 🥳
        ${nombre}

        *FELIZ 2026!* 🎉  
        Cancelá tu cuenta con el *50% de la deuda total*

        💰 Deuda actual: $${total_deuda.toLocaleString("es-AR")}
        🔥 Promo cancelatoria: $${promo.toLocaleString("es-AR")}

        Transferí $${promo.toLocaleString("es-AR")}
        Alias: *LevsuMuebles.mp*

        🔒 _No se reciben pagos parciales para aplicar a la promoción_

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

function heredoc(strings, ...values) {
  let raw = strings.reduce((acc, str, i) => acc + str + (values[i] ?? ""), "");

  const lines = raw.split("\n");

  // quitar líneas vacías inicial/final
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();

  const indent = Math.min(
    ...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length),
  );

  return lines.map((l) => l.slice(indent)).join("\n");
}

function parseDbBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (value == null) return false;

  const normalized = String(value).trim().toLowerCase();
  return ["1", "true", "t", "si", "sí", "on", "yes", "y"].includes(
    normalized,
  );
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
  const ahora = new Date();
  const hora = ahora.getHours(); // 0–23

  let conn;
  const hoy = new Date();
  const diaSemana = hoy.getDay(); // 0=Domingo
  const LIMITE_ENVIO = 50;

  let enviados = 0;
  let errores = 0;

  try {
    conn = await getConnectionWithRelease();

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
    if (hora < CRON_START_HOUR || hora >= CRON_END_HOUR) {
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

    for (const row of rows) {
      if (enviados >= LIMITE_ENVIO) {
        console.log(`⏹️ Límite de ${LIMITE_ENVIO} envíos alcanzado`);
        break;
      }

      const { id_credito, celular, nombre, fecha_vencimiento, nombre_empresa } =
        row;

      // Normalizar fechas (evita errores por hora)
      const dias = Math.round(
        (new Date(fecha_vencimiento).setHours(0, 0, 0, 0) -
          new Date(hoy).setHours(0, 0, 0, 0)) /
          86400000,
      );

      const esUrgente = dias === 0 || dias === 1;

      let enviar = false;

      if (diaSemana === 0) {
        // 🟣 DOMINGO → solo HOY o MAÑANA
        if (esUrgente) {
          enviar = true;
        }
      } else {
        // 🟢 LUNES A SÁBADO
        if (esUrgente) {
          enviar = true;
        } else {
          const esPar = id_credito % 2 === 0;

          if (
            (esPar && [1, 3, 5].includes(diaSemana)) ||
            (!esPar && [2, 4, 6].includes(diaSemana))
          ) {
            enviar = true;
          }
        }
      }

      if (!enviar) continue;

      // 🔒 LOCK
      const lockResult = await conn.query(
        `
        UPDATE creditos
        SET recordatorio_lock = 1
        WHERE id = ?
          AND recordatorio_lock = 0
        `,
        [id_credito],
      );

      if (lockResult.affectedRows !== 1) continue;

      try {
        const mensaje = generarMensaje({
          nombre,
          dias,
          id_credito,
          total_deuda: row.total_deuda,
          fecha_vencimiento: row.fecha_vencimiento,
          id_empresa: ID_EMPRESA,
          cbu_alias: row.cbu_alias,
        });

        let resul_envio = await enviar_mensaje({
          to: celular,
          message: mensaje,
          id_operador: 0, // cron
        });

        console.log(
          resul_envio,
          "Crédito:",
          id_credito,
          "Empresa:",
          nombre_empresa,
          "Cliente:",
          nombre,
        );

        await conn.query(
          `
          UPDATE creditos
          SET recordatorio_update = NOW(),
              recordatorio_lock = 0
          WHERE id = ?
          `,
          [id_credito],
        );

        enviados++;
        await sleep(700);
      } catch (err) {
        errores++;
        logError(`❌ Error crédito ${id_credito}`, err, {
          id_credito,
          empresa: ID_EMPRESA,
        });
        // NO liberar → evita duplicados
      }
    }

    console.log(
      `📊 Cron → Empresa ${ID_EMPRESA} | Enviados: ${enviados} | Errores: ${errores}`,
    );
  } catch (err) {
    logError("🔥 Error crítico en cron", err, { empresa: ID_EMPRESA });
  } finally {
    if (conn) conn.release();
  }
}

(async () => {
  await initWhatsApp();

  app.listen(PORT, () => {
    console.log(`🚀 API WhatsApp en http://localhost:${PORT}`);
    console.log("Server started successfully."); // 👈 AQUÍ
  });
})();

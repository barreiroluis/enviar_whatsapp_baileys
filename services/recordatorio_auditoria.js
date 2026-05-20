import moment from "moment-timezone";
import crypto from "node:crypto";

let schemaReady = false;

export function getFechaLocal(timeZone, now = new Date()) {
  return moment.tz(now, timeZone).format("YYYY-MM-DD");
}

export function getDateTimeLocal(timeZone, now = new Date()) {
  return moment.tz(now, timeZone).format("YYYY-MM-DD HH:mm:ss");
}

function shortText(value, maxLength = 255) {
  const text = String(value || "").trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

async function hasColumn(conn, tableName, columnName) {
  const rows = await conn.query(
    `
    SHOW COLUMNS FROM \`${tableName}\` LIKE ?
    `,
    [columnName],
  );
  return rows.length > 0;
}

async function hasIndex(conn, tableName, indexName) {
  const rows = await conn.query(
    `
    SHOW INDEX FROM \`${tableName}\` WHERE Key_name = ?
    `,
    [indexName],
  );
  return rows.length > 0;
}

async function addColumnIfMissing(conn, tableName, columnName, ddl) {
  if (await hasColumn(conn, tableName, columnName)) return;
  await conn.query(`ALTER TABLE \`${tableName}\` ADD COLUMN ${ddl}`);
}

async function addIndexIfMissing(conn, tableName, indexName, ddl) {
  if (await hasIndex(conn, tableName, indexName)) return;
  await conn.query(`ALTER TABLE \`${tableName}\` ADD ${ddl}`);
}

function buildAuditKey(detalle) {
  const parts = [
    detalle.id_credito || "",
    detalle.id_cliente || "",
    detalle.evento || "none",
    detalle.estado || "",
    detalle.motivo || "",
    detalle.fecha_vencimiento || "",
    Number.isFinite(detalle.dias_para_vencimiento)
      ? detalle.dias_para_vencimiento
      : "",
  ];

  return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
}

export async function ensureRecordatorioAuditSchema(conn) {
  if (schemaReady) return;

  await conn.query(`
    CREATE TABLE IF NOT EXISTS recordatorio_cron_runs (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      id_empresa BIGINT NOT NULL,
      started_at DATETIME NOT NULL,
      finished_at DATETIME NULL,
      fecha_local DATE NOT NULL,
      timezone VARCHAR(80) NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
      status ENUM(
        'running',
        'ok',
        'partial_error',
        'error',
        'whatsapp_disconnected',
        'outside_schedule',
        'cron_disabled'
      ) NOT NULL DEFAULT 'running',
      candidatos_db INT NOT NULL DEFAULT 0,
      candidatos_enviables INT NOT NULL DEFAULT 0,
      enviados INT NOT NULL DEFAULT 0,
      errores INT NOT NULL DEFAULT 0,
      omitidos INT NOT NULL DEFAULT 0,
      limite_alcanzado TINYINT(1) NOT NULL DEFAULT 0,
      error_message TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_empresa_fecha (id_empresa, fecha_local),
      INDEX idx_status (status),
      INDEX idx_started_at (started_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS recordatorio_cron_detalle (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      id_run BIGINT UNSIGNED NOT NULL,
      id_empresa BIGINT NOT NULL,
      id_cliente BIGINT NULL,
      id_credito BIGINT NULL,
      celular VARCHAR(40) NULL,
      nombre_cliente VARCHAR(255) NULL,
      evento ENUM('due_3', 'due_1', 'due_0', 'overdue', 'none') NOT NULL DEFAULT 'none',
      estado ENUM('candidato', 'enviado', 'omitido', 'error') NOT NULL,
      motivo VARCHAR(255) NULL,
      fecha_local DATE NULL,
      fecha_vencimiento DATE NULL,
      dias_para_vencimiento INT NULL,
      deuda_total DECIMAL(14,2) NULL,
      id_msg VARCHAR(120) NULL,
      error_message TEXT NULL,
      audit_key CHAR(64) NULL,
      first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      veces INT NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_run (id_run),
      INDEX idx_empresa_fecha (id_empresa, created_at),
      INDEX idx_empresa_fecha_local (id_empresa, fecha_local),
      INDEX idx_credito (id_credito),
      INDEX idx_cliente (id_cliente),
      INDEX idx_estado (estado),
      UNIQUE KEY uk_recordatorio_detalle_dia (id_empresa, fecha_local, audit_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await addColumnIfMissing(
    conn,
    "recordatorio_cron_detalle",
    "fecha_local",
    "fecha_local DATE NULL AFTER motivo",
  );
  await addColumnIfMissing(
    conn,
    "recordatorio_cron_detalle",
    "audit_key",
    "audit_key CHAR(64) NULL AFTER error_message",
  );
  await addColumnIfMissing(
    conn,
    "recordatorio_cron_detalle",
    "first_seen_at",
    "first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER audit_key",
  );
  await addColumnIfMissing(
    conn,
    "recordatorio_cron_detalle",
    "last_seen_at",
    "last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER first_seen_at",
  );
  await addColumnIfMissing(
    conn,
    "recordatorio_cron_detalle",
    "veces",
    "veces INT NOT NULL DEFAULT 1 AFTER last_seen_at",
  );
  await addIndexIfMissing(
    conn,
    "recordatorio_cron_detalle",
    "idx_empresa_fecha_local",
    "INDEX idx_empresa_fecha_local (id_empresa, fecha_local)",
  );
  await addIndexIfMissing(
    conn,
    "recordatorio_cron_detalle",
    "uk_recordatorio_detalle_dia",
    "UNIQUE KEY uk_recordatorio_detalle_dia (id_empresa, fecha_local, audit_key)",
  );

  await conn.query(`
    CREATE TABLE IF NOT EXISTS recordatorio_owner_reportes (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      id_empresa BIGINT NOT NULL,
      fecha_local DATE NOT NULL,
      celular_owner VARCHAR(40) NULL,
      estado ENUM('pendiente', 'enviado', 'error', 'sin_owner') NOT NULL DEFAULT 'pendiente',
      id_msg VARCHAR(120) NULL,
      resumen TEXT NULL,
      error_message TEXT NULL,
      sent_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_empresa_fecha (id_empresa, fecha_local),
      INDEX idx_estado (estado)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  schemaReady = true;
}

export async function createRecordatorioRun(conn, { idEmpresa, timeZone, now }) {
  await ensureRecordatorioAuditSchema(conn);

  const startedAt = getDateTimeLocal(timeZone, now);
  const fechaLocal = getFechaLocal(timeZone, now);
  const result = await conn.query(
    `
    INSERT INTO recordatorio_cron_runs
      (id_empresa, started_at, fecha_local, timezone)
    VALUES (?, ?, ?, ?)
    `,
    [idEmpresa, startedAt, fechaLocal, timeZone],
  );

  return result.insertId;
}

export async function finishRecordatorioRun(conn, idRun, data = {}) {
  if (!idRun) return;

  await conn.query(
    `
    UPDATE recordatorio_cron_runs
    SET
      finished_at = COALESCE(?, finished_at),
      status = COALESCE(?, status),
      candidatos_db = COALESCE(?, candidatos_db),
      candidatos_enviables = COALESCE(?, candidatos_enviables),
      enviados = COALESCE(?, enviados),
      errores = COALESCE(?, errores),
      omitidos = COALESCE(?, omitidos),
      limite_alcanzado = COALESCE(?, limite_alcanzado),
      error_message = COALESCE(?, error_message)
    WHERE id = ?
    `,
    [
      data.finished_at || null,
      data.status || null,
      data.candidatos_db ?? null,
      data.candidatos_enviables ?? null,
      data.enviados ?? null,
      data.errores ?? null,
      data.omitidos ?? null,
      data.limite_alcanzado == null ? null : Number(Boolean(data.limite_alcanzado)),
      data.error_message || null,
      idRun,
    ],
  );
}

export async function insertRecordatorioDetalle(conn, detalle) {
  if (!detalle?.id_run) return;
  const fechaLocal = detalle.fecha_local || moment().format("YYYY-MM-DD");
  const auditKey = detalle.audit_key || buildAuditKey({ ...detalle, fecha_local: fechaLocal });

  await conn.query(
    `
    INSERT INTO recordatorio_cron_detalle
      (
        id_run,
        id_empresa,
        id_cliente,
        id_credito,
        celular,
        nombre_cliente,
        evento,
        estado,
        motivo,
        fecha_local,
        fecha_vencimiento,
        dias_para_vencimiento,
        deuda_total,
        id_msg,
        error_message,
        audit_key
      )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      id_run = VALUES(id_run),
      celular = COALESCE(VALUES(celular), celular),
      nombre_cliente = COALESCE(VALUES(nombre_cliente), nombre_cliente),
      deuda_total = VALUES(deuda_total),
      id_msg = COALESCE(VALUES(id_msg), id_msg),
      error_message = COALESCE(VALUES(error_message), error_message),
      last_seen_at = CURRENT_TIMESTAMP,
      veces = veces + 1
    `,
    [
      detalle.id_run,
      detalle.id_empresa,
      detalle.id_cliente || null,
      detalle.id_credito || null,
      shortText(detalle.celular, 40) || null,
      shortText(detalle.nombre_cliente) || null,
      detalle.evento || "none",
      detalle.estado,
      shortText(detalle.motivo) || null,
      fechaLocal,
      detalle.fecha_vencimiento || null,
      Number.isFinite(detalle.dias_para_vencimiento)
        ? detalle.dias_para_vencimiento
        : null,
      Number(detalle.deuda_total || 0) || 0,
      shortText(detalle.id_msg, 120) || null,
      detalle.error_message ? String(detalle.error_message).slice(0, 2000) : null,
      auditKey,
    ],
  );
}

export function buildDetalleFromCredito({
  idRun,
  idEmpresa,
  credito,
  evento = "none",
  estado,
  motivo,
  idMsg,
  errorMessage,
  fechaLocal,
}) {
  const fechaVencimiento = credito?.fecha_vencimiento
    ? moment(credito.fecha_vencimiento).format("YYYY-MM-DD")
    : null;

  return {
    id_run: idRun,
    id_empresa: idEmpresa,
    id_cliente: credito?.id_cliente,
    id_credito: credito?.id_credito,
    celular: credito?.celular,
    nombre_cliente: credito?.nombre,
    evento,
    estado,
    motivo,
    fecha_local: fechaLocal,
    fecha_vencimiento: fechaVencimiento,
    dias_para_vencimiento: credito?.dias,
    deuda_total: credito?.total_deuda,
    id_msg: idMsg,
    error_message: errorMessage,
  };
}

export async function getOwnerForEmpresa(conn, idEmpresa) {
  const rows = await conn.query(
    `
    SELECT pe.celular, pe.nombre, em.nombre AS nombre_empresa
    FROM empresas em
    LEFT JOIN persona pe
      ON pe.id = em.id_owner
    WHERE em.id = ?
    LIMIT 1
    `,
    [idEmpresa],
  );

  return rows?.[0] || null;
}

export async function getDailyRecordatorioSummary(conn, idEmpresa, fechaLocal) {
  const runRows = await conn.query(
    `
    SELECT
      COUNT(*) AS corridas,
      COALESCE(SUM(candidatos_db), 0) AS candidatos_db,
      COALESCE(SUM(candidatos_enviables), 0) AS candidatos_enviables,
      COALESCE(SUM(enviados), 0) AS enviados,
      COALESCE(SUM(errores), 0) AS errores,
      COALESCE(SUM(omitidos), 0) AS omitidos,
      MAX(limite_alcanzado) AS limite_alcanzado,
      SUBSTRING_INDEX(GROUP_CONCAT(status ORDER BY started_at DESC SEPARATOR ','), ',', 1) AS ultimo_status,
      MAX(finished_at) AS ultima_ejecucion
    FROM recordatorio_cron_runs
    WHERE id_empresa = ?
      AND fecha_local = ?
    `,
    [idEmpresa, fechaLocal],
  );

  const eventRows = await conn.query(
    `
    SELECT d.evento, COUNT(*) AS total
    FROM recordatorio_cron_detalle d
    INNER JOIN recordatorio_cron_runs r
      ON r.id = d.id_run
    WHERE d.id_empresa = ?
      AND r.fecha_local = ?
      AND d.estado = 'enviado'
    GROUP BY d.evento
    `,
    [idEmpresa, fechaLocal],
  );

  const errorRows = await conn.query(
    `
    SELECT d.id_credito, d.nombre_cliente, d.motivo, d.error_message
    FROM recordatorio_cron_detalle d
    INNER JOIN recordatorio_cron_runs r
      ON r.id = d.id_run
    WHERE d.id_empresa = ?
      AND r.fecha_local = ?
      AND d.estado = 'error'
    ORDER BY d.id DESC
    LIMIT 5
    `,
    [idEmpresa, fechaLocal],
  );

  return {
    ...(runRows?.[0] || {}),
    eventos: eventRows || [],
    errores_detalle: errorRows || [],
  };
}

export async function getOwnerReporte(conn, idEmpresa, fechaLocal) {
  const rows = await conn.query(
    `
    SELECT *
    FROM recordatorio_owner_reportes
    WHERE id_empresa = ?
      AND fecha_local = ?
    LIMIT 1
    `,
    [idEmpresa, fechaLocal],
  );

  return rows?.[0] || null;
}

export async function upsertOwnerReporte(conn, data) {
  const existing = await getOwnerReporte(conn, data.id_empresa, data.fecha_local);
  if (!existing) {
    const result = await conn.query(
      `
      INSERT INTO recordatorio_owner_reportes
        (id_empresa, fecha_local, celular_owner, estado, id_msg, resumen, error_message, sent_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        data.id_empresa,
        data.fecha_local,
        data.celular_owner || null,
        data.estado || "pendiente",
        data.id_msg || null,
        data.resumen || null,
        data.error_message || null,
        data.sent_at || null,
      ],
    );
    return result.insertId;
  }

  await conn.query(
    `
    UPDATE recordatorio_owner_reportes
    SET
      celular_owner = COALESCE(?, celular_owner),
      estado = ?,
      id_msg = COALESCE(?, id_msg),
      resumen = COALESCE(?, resumen),
      error_message = ?,
      sent_at = COALESCE(?, sent_at)
    WHERE id = ?
    `,
    [
      data.celular_owner || null,
      data.estado || existing.estado,
      data.id_msg || null,
      data.resumen || null,
      data.error_message || null,
      data.sent_at || null,
      existing.id,
    ],
  );

  return existing.id;
}

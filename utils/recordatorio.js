import moment from "moment-timezone";

export const DEFAULT_TIME_ZONE = "America/Argentina/Buenos_Aires";

function toDateOnlyMoment(dateValue, timeZone = DEFAULT_TIME_ZONE) {
  if (!dateValue) return null;

  const normalized = moment(dateValue).format("YYYY-MM-DD");
  const parsed = moment.tz(normalized, "YYYY-MM-DD", true, timeZone);

  return parsed.isValid() ? parsed.startOf("day") : null;
}

export function isTodayInTimeZone(
  dateValue,
  timeZone = DEFAULT_TIME_ZONE,
  now = new Date(),
) {
  const fecha = toDateOnlyMoment(dateValue, timeZone);
  if (!fecha) return false;

  return fecha.isSame(moment.tz(now, timeZone).startOf("day"), "day");
}

export function isHourAllowed(hour, startHour, endHour) {
  return hour >= startHour && hour < endHour;
}

export function calcularDiasHastaVencimiento(
  fechaVencimiento,
  hoy = new Date(),
  timeZone = DEFAULT_TIME_ZONE,
) {
  const fecha = toDateOnlyMoment(fechaVencimiento, timeZone);
  if (!fecha) return Number.NaN;

  const hoyMoment = moment.tz(hoy, timeZone).startOf("day");
  return fecha.diff(hoyMoment, "days");
}

export function describirEstadoVencimiento(dias) {
  if (dias < 0) return `Vencido hace ${Math.abs(dias)} días`;
  if (dias === 0) return "Vence hoy";
  if (dias === 1) return "Vence mañana";
  return `Vence en ${dias} días`;
}

export function debeEnviarCreditoHoy({ diaSemana, dias, id_credito }) {
  const esUrgente = dias === 0 || dias === 1;

  if (diaSemana === 0) {
    return esUrgente;
  }

  if (esUrgente) {
    return true;
  }

  const esPar = id_credito % 2 === 0;
  return (
    (esPar && [1, 3, 5].includes(diaSemana)) ||
    (!esPar && [2, 4, 6].includes(diaSemana))
  );
}

export function generarMensajeVisitaHoy(nombre) {
  return heredoc`
    Hola ${nombre}, nuestro motorizado pasará por *tu casa hoy* 🏠👈🏍️ por la cuota, si tienes alguna preferencia de hora dínosla para evitar que no te encontremos.
  `;
}

export function agruparCreditosPorCelular({
  rows,
  hoy = new Date(),
  diaSemana,
  timeZone = DEFAULT_TIME_ZONE,
}) {
  const gruposPorCelular = new Map();

  for (const row of rows) {
    const { id_credito, celular } = row;

    if (!celular) continue;

    const dias = calcularDiasHastaVencimiento(row.fecha_vencimiento, hoy, timeZone);
    if (!Number.isFinite(dias)) continue;

    const enviar = debeEnviarCreditoHoy({
      diaSemana,
      dias,
      id_credito,
    });

    if (!enviar) continue;

    const key = String(celular).trim();

    if (!gruposPorCelular.has(key)) {
      gruposPorCelular.set(key, {
        celular: key,
        nombre: row.nombre,
        nombre_empresa: row.nombre_empresa,
        cbu_alias: row.cbu_alias,
        visitaHoy: false,
        creditos: [],
      });
    }

    if (isTodayInTimeZone(row.fecha_proxima_visita, timeZone, hoy)) {
      gruposPorCelular.get(key).visitaHoy = true;
    }

    gruposPorCelular.get(key).creditos.push({
      id_credito,
      dias,
      total_deuda: row.total_deuda,
    });
  }

  return gruposPorCelular;
}

export function heredoc(strings, ...values) {
  let raw = strings.reduce((acc, str, i) => acc + str + (values[i] ?? ""), "");

  const lines = raw.split("\n");

  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();

  const nonEmptyLines = lines.filter((line) => line.trim());
  const indent = nonEmptyLines.length
    ? Math.min(...nonEmptyLines.map((line) => line.match(/^ */)[0].length))
    : 0;

  return lines
    .map((line) => line.slice(indent).trimEnd())
    .join("\n")
    .replace(/^[ \t]+/gm, "");
}

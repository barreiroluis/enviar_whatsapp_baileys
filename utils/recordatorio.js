import moment from "moment-timezone";
import { DEFAULT_TIME_ZONE } from "./timezone.js";

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
  if (dias < 0) {
    const diasVencido = Math.abs(dias);
    if (diasVencido >= 365) {
      const years = Math.floor(diasVencido / 365);
      const remainingDays = diasVencido % 365;
      const months = Math.floor(remainingDays / 30);
      const yearsLabel = `${years} ${years === 1 ? "año" : "años"}`;
      if (months > 0) {
        return `Vencido hace ${yearsLabel} y ${months} ${months === 1 ? "mes" : "meses"}`;
      }
      return `Vencido hace ${yearsLabel}`;
    }

    if (diasVencido >= 30) {
      const months = Math.floor(diasVencido / 30);
      return `Vencido hace ${months} ${months === 1 ? "mes" : "meses"}`;
    }

    return `Vencido hace ${diasVencido} días`;
  }
  if (dias === 0) return "Vence hoy";
  if (dias === 1) return "Vence mañana";
  return `Vence en ${dias} días`;
}

export function calcularDiasDesdeFecha(
  fechaValue,
  hoy = new Date(),
  timeZone = DEFAULT_TIME_ZONE,
) {
  if (!fechaValue) return Number.NaN;

  const fecha = moment.tz(fechaValue, timeZone);
  if (!fecha.isValid()) return Number.NaN;

  return moment.tz(hoy, timeZone).startOf("day").diff(fecha.startOf("day"), "days");
}

export function getDefaultRecordatorioConfig() {
  return {
    cron_recordatorio: false,
    schedule: {
      start_hour: 9,
      end_hour: 20,
    },
    delivery: {
      max_messages_per_run: 25,
    },
    templates: {
      events: {
        due_3: {
          enabled: 1,
          template:
            "Hola {name}, te recordamos que tu crédito #{credito_id} por {articulos} *vence en 3 días*.\n\nPróxima cuota a pagar: ${valor_proxima_cuota}\nVer detalle: {resumen_url}\n\n*Formas de pago*\n- RapiPago\n- PagoFácil\n- Saldo MercadoPago\n- Transferencia\n{cbu_alias}\n\n📎 Si ya pagaste, podés responder este mensaje con el comprobante.",
        },
        due_1: {
          enabled: 1,
          template:
            "Hola {name}, te recordamos que tu crédito #{credito_id} por {articulos} *vence mañana*.\n\nPróxima cuota a pagar: ${valor_proxima_cuota}\nVer detalle: {resumen_url}\n\n*Formas de pago*\n- RapiPago\n- PagoFácil\n- Saldo MercadoPago\n- Transferencia\n{cbu_alias}\n\n📎 Si ya pagaste, podés responder este mensaje con el comprobante.",
        },
        due_0: {
          enabled: 1,
          template:
            "Hola {name}, te recordamos que tu crédito #{credito_id} por {articulos} *vence hoy*.\n\nValor a pagar para ponerte al día: ${valor_a_pagar}\nVer detalle: {resumen_url}\n\n*Formas de pago*\n- RapiPago\n- PagoFácil\n- Saldo MercadoPago\n- Transferencia\n{cbu_alias}\n\n📎 Si ya pagaste, podés responder este mensaje con el comprobante.",
        },
        overdue: {
          enabled: 1,
          first_notice_after_days: 1,
          repeat_every_days: 3,
          template:
            "Hola {name}, tu crédito #{credito_id} por {articulos} *{estado_vencimiento}*.\n\nValor a pagar para ponerte al día: ${valor_a_pagar}\nVer detalle: {resumen_url}\n\n*Formas de pago*\n- RapiPago\n- PagoFácil\n- Saldo MercadoPago\n- Transferencia\n{cbu_alias}\n\n📎 Si ya pagaste, podés responder este mensaje con el comprobante.",
        },
      },
    },
  };
}

export function normalizarRecordatorioConfig(rawConfig = {}) {
  const defaults = getDefaultRecordatorioConfig();
  const rawSchedule = rawConfig.schedule || {};
  const rawDelivery = rawConfig.delivery || {};
  const rawTemplates = rawConfig.templates || {};
  const rawEvents = rawTemplates.events || {};
  const rawOverdue = rawEvents.overdue || {};

  return {
    cron_recordatorio:
      rawConfig.cron_recordatorio ?? defaults.cron_recordatorio,
    schedule: {
      start_hour:
        Number(rawSchedule.start_hour ?? defaults.schedule.start_hour) ||
        defaults.schedule.start_hour,
      end_hour:
        Number(rawSchedule.end_hour ?? defaults.schedule.end_hour) ||
        defaults.schedule.end_hour,
    },
    delivery: {
      max_messages_per_run:
        Number(
          rawDelivery.max_messages_per_run ??
            defaults.delivery.max_messages_per_run,
        ) || defaults.delivery.max_messages_per_run,
    },
    templates: {
      events: {
        due_3: {
          enabled: Number(
            rawEvents.due_3?.enabled ??
              defaults.templates.events.due_3.enabled,
          ),
          template:
            rawEvents.due_3?.template ??
            defaults.templates.events.due_3.template,
        },
        due_1: {
          enabled: Number(
            rawEvents.due_1?.enabled ??
              defaults.templates.events.due_1.enabled,
          ),
          template:
            rawEvents.due_1?.template ??
            defaults.templates.events.due_1.template,
        },
        due_0: {
          enabled: Number(
            rawEvents.due_0?.enabled ??
              defaults.templates.events.due_0.enabled,
          ),
          template:
            rawEvents.due_0?.template ??
            defaults.templates.events.due_0.template,
        },
        overdue: {
          enabled: Number(
            rawOverdue.enabled ?? defaults.templates.events.overdue.enabled,
          ),
          first_notice_after_days:
            Number(
              rawOverdue.first_notice_after_days ??
                defaults.templates.events.overdue.first_notice_after_days,
            ) || defaults.templates.events.overdue.first_notice_after_days,
          repeat_every_days:
            Number(
              rawOverdue.repeat_every_days ??
                defaults.templates.events.overdue.repeat_every_days,
            ) || defaults.templates.events.overdue.repeat_every_days,
          template:
            rawOverdue.template ?? defaults.templates.events.overdue.template,
        },
      },
    },
  };
}

export function getRecordatorioEventKey(dias, config) {
  const events = config?.templates?.events || {};

  if (dias === 3 && Number(events.due_3?.enabled) === 1) return "due_3";
  if (dias === 1 && Number(events.due_1?.enabled) === 1) return "due_1";
  if (dias === 0 && Number(events.due_0?.enabled) === 1) return "due_0";
  if (dias < 0 && Number(events.overdue?.enabled) === 1) return "overdue";

  return null;
}

export function shouldSendOverdueCredit({
  dias,
  recordatorio_update,
  fecha_vencimiento,
  hoy = new Date(),
  config,
  timeZone = DEFAULT_TIME_ZONE,
}) {
  const overdueConfig = config?.templates?.events?.overdue || {};
  const diasVencido = Math.abs(Number(dias || 0));
  const firstNotice = Math.max(1, Number(overdueConfig.first_notice_after_days || 1));
  const repeatEvery = Math.max(1, Number(overdueConfig.repeat_every_days || 1));

  if (dias >= 0 || diasVencido < firstNotice) {
    return false;
  }

  if (!recordatorio_update) {
    return true;
  }

  const ultimoRecordatorio = moment.tz(recordatorio_update, timeZone);
  if (!ultimoRecordatorio.isValid()) {
    return true;
  }

  const fechaVencimiento = toDateOnlyMoment(fecha_vencimiento, timeZone);
  const hoyMoment = moment.tz(hoy, timeZone).startOf("day");
  const ultimoRecordatorioDia = ultimoRecordatorio.clone().startOf("day");

  if (!fechaVencimiento) {
    return hoyMoment.diff(ultimoRecordatorioDia, "days") >= repeatEvery;
  }

  if (ultimoRecordatorioDia.isBefore(fechaVencimiento)) {
    return true;
  }

  return hoyMoment.diff(ultimoRecordatorioDia, "days") >= repeatEvery;
}

export function shouldSendCredit({
  row,
  dias,
  config,
  hoy = new Date(),
  timeZone = DEFAULT_TIME_ZONE,
}) {
  const eventKey = getRecordatorioEventKey(dias, config);
  if (!eventKey) return false;

  if (eventKey !== "overdue") {
    return true;
  }

  return shouldSendOverdueCredit({
    dias,
    recordatorio_update: row.recordatorio_update,
    fecha_vencimiento: row.fecha_vencimiento,
    hoy,
    config,
    timeZone,
  });
}

export function renderTemplate(template, variables = {}) {
  return String(template || "").replace(/\{[a-zA-Z0-9_]+\}/g, (token) => {
    const key = token.slice(1, -1);
    const value = Object.prototype.hasOwnProperty.call(variables, key)
      ? variables[key]
      : "";
    return value == null ? "" : String(value);
  });
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

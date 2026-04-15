import test from "node:test";
import assert from "node:assert/strict";

import {
  describirEstadoVencimiento,
  getDefaultRecordatorioConfig,
  heredoc,
  isHourAllowed,
  normalizarRecordatorioConfig,
  renderTemplate,
  shouldSendCredit,
} from "../utils/recordatorio.js";
import {
  DEFAULT_TIME_ZONE,
  resolveAppTimeZone,
} from "../utils/timezone.js";

test("permite envios solo entre las 9 y las 20", () => {
  assert.equal(isHourAllowed(8, 9, 20), false);
  assert.equal(isHourAllowed(9, 9, 20), true);
  assert.equal(isHourAllowed(19, 9, 20), true);
  assert.equal(isHourAllowed(20, 9, 20), false);
});

test("usa config por defecto para 3, 1, hoy y vencidos", () => {
  const config = getDefaultRecordatorioConfig();

  assert.equal(config.templates.events.due_3.enabled, 1);
  assert.equal(config.templates.events.due_1.enabled, 1);
  assert.equal(config.templates.events.due_0.enabled, 1);
  assert.equal(config.templates.events.overdue.enabled, 1);
});

test("humaniza vencidos largos en meses y años", () => {
  assert.equal(describirEstadoVencimiento(-45), "Vencido hace 1 mes");
  assert.equal(describirEstadoVencimiento(-1436), "Vencido hace 3 años y 11 meses");
});

test("envia vencidos cuando ya corresponde el primer aviso", () => {
  const config = normalizarRecordatorioConfig({
    templates: {
      events: {
        overdue: {
          enabled: 1,
          first_notice_after_days: 3,
          repeat_every_days: 5,
        },
      },
    },
  });

  const row = {
    fecha_vencimiento: "2026-04-10",
    recordatorio_update: null,
  };

  assert.equal(
    shouldSendCredit({
      row,
      dias: -3,
      config,
      hoy: new Date("2026-04-13T10:00:00-03:00"),
      timeZone: "America/Argentina/Buenos_Aires",
    }),
    true,
  );
});

test("no reenvia vencidos antes de cumplir la frecuencia configurada", () => {
  const config = normalizarRecordatorioConfig({
    templates: {
      events: {
        overdue: {
          enabled: 1,
          first_notice_after_days: 1,
          repeat_every_days: 3,
        },
      },
    },
  });

  const row = {
    fecha_vencimiento: "2026-04-10",
    recordatorio_update: "2026-04-12 08:00:00",
  };

  assert.equal(
    shouldSendCredit({
      row,
      dias: -4,
      config,
      hoy: new Date("2026-04-13T10:00:00-03:00"),
      timeZone: "America/Argentina/Buenos_Aires",
    }),
    false,
  );
});

test("el primer aviso vencido no queda bloqueado por un recordatorio previo al vencimiento", () => {
  const config = normalizarRecordatorioConfig({
    templates: {
      events: {
        overdue: {
          enabled: 1,
          first_notice_after_days: 1,
          repeat_every_days: 3,
        },
      },
    },
  });

  const row = {
    fecha_vencimiento: "2026-04-10",
    recordatorio_update: "2026-04-09 11:00:00",
  };

  assert.equal(
    shouldSendCredit({
      row,
      dias: -1,
      config,
      hoy: new Date("2026-04-11T10:00:00-03:00"),
      timeZone: "America/Argentina/Buenos_Aires",
    }),
    true,
  );
});

test("renderTemplate reemplaza variables desconocidas por vacio", () => {
  const mensaje = renderTemplate("Hola {name} {missing}", { name: "Luis" });
  assert.equal(mensaje, "Hola Luis ");
});

test("heredoc elimina espacios a la izquierda en el mensaje final", () => {
  const formasPago = heredoc`
    *Formas de pago*
    - RapiPago
    - PagoFácil
    - Transferencia
  `;

  const mensaje = heredoc`
    Hola Juan

    ${formasPago}
  `;

  for (const line of mensaje.split("\n")) {
    assert.equal(line.startsWith("    "), false);
  }
});

test("usa TIME como fuente de zona horaria y cae al default si no existe", () => {
  assert.equal(
    resolveAppTimeZone({ TIME: "America/Mexico_City" }),
    "America/Mexico_City",
  );
  assert.equal(resolveAppTimeZone({ TZ: "Etc/UTC" }), DEFAULT_TIME_ZONE);
  assert.equal(resolveAppTimeZone({}), DEFAULT_TIME_ZONE);
});

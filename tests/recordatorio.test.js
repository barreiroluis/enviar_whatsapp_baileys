import test from "node:test";
import assert from "node:assert/strict";

import {
  agruparCreditosPorCelular,
  heredoc,
  isHourAllowed,
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

test("agrupa multiples creditos del mismo celular en un solo envio", () => {
  const rows = [
    {
      id_credito: 10,
      celular: "3815551111",
      nombre: "Leandro",
      nombre_empresa: "Empresa",
      cbu_alias: "ALIAS.EMPRESA",
      fecha_vencimiento: "2026-02-28",
      total_deuda: 1000,
      articulos: "Sillon Esquinero",
    },
    {
      id_credito: 11,
      celular: "3815551111",
      nombre: "Leandro",
      nombre_empresa: "Empresa",
      cbu_alias: "ALIAS.EMPRESA",
      fecha_vencimiento: "2026-02-28",
      total_deuda: 2000,
      articulos: "Mesa Ratona",
    },
  ];

  const grupos = agruparCreditosPorCelular({
    rows,
    hoy: new Date("2026-02-28T12:00:00-03:00"),
    diaSemana: 6,
    timeZone: "America/Argentina/Buenos_Aires",
  });

  assert.equal(grupos.size, 1);

  const grupo = grupos.get("3815551111");
  assert.ok(grupo);
  assert.equal(grupo.creditos.length, 2);
  assert.equal(grupo.creditos[0].articulos, "Sillon Esquinero");
  assert.equal(grupo.creditos[1].articulos, "Mesa Ratona");
});

test("heredoc elimina espacios a la izquierda en el mensaje final", () => {
  const formasPago = heredoc`
    *Formas de pago*
    - RapiPago
    - PagoFácil
    - Transferencia
  `;

  const mensaje = heredoc`
    *RECORDATORIO*
    LEANDRO DAVID JUÁREZ

    Tenés 1 crédito(s) para revisar:

    • Crédito #1651673431
    Vencido hace 1298 días
    Deuda: $19.500
    https://cuotafacil.com/cuotas.php?id=1651673431

    ${formasPago}
  `;

  for (const line of mensaje.split("\n")) {
    assert.equal(line.startsWith("    "), false);
  }
});

test("usa TIME como fuente de zona horaria y cae al default si no existe", () => {
  assert.equal(resolveAppTimeZone({ TIME: "America/Mexico_City" }), "America/Mexico_City");
  assert.equal(resolveAppTimeZone({ TZ: "Etc/UTC" }), DEFAULT_TIME_ZONE);
  assert.equal(resolveAppTimeZone({}), DEFAULT_TIME_ZONE);
});

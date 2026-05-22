# whatsapp-baileys

Servicio de WhatsApp con Baileys + API HTTP para envio de mensajes y recordatorios por cron.

## Requisitos

- Node.js 20+
- NPM
- (Opcional) MySQL si `DATABASE=mysql`

## Instalacion

```bash
npm install
cp .env.example .env
```

Configura tus variables en `.env`.

Define `TIME=America/Argentina/Buenos_Aires` en `.env` para que el cron y los
timestamps internos usen la hora correcta.

## Ejecutar

```bash
npm start
```

Por defecto levanta en `http://localhost:3000`.

## Endpoints

- `GET /health`: estado general del servidor y cuentas cargadas
- `GET /accounts`: lista cuentas de notificacion de la empresa
- `POST /accounts`: crea una cuenta adicional de notificacion
- `GET /accounts/:account_key/qr`: stream SSE con QR de una cuenta especifica
- `DELETE /accounts/:account_key`: da de baja la cuenta y elimina su sesion local
- `GET /qr`: stream SSE con el QR de vinculacion
- `POST /send`: envio de mensaje
- `POST /run-cron-now`: ejecucion manual del cron

Compatibilidad:

- `GET /qr` sigue usando la cuenta `default`.
- `POST /send` sin `account_key` ni `id_sucursal` sigue usando la cuenta `default`.
- La cuenta `default` mantiene `WA_SESSION_PATH`, por lo que las sesiones actuales no se mueven.
- Las cuentas adicionales usan subcarpetas por `account_key`.

Recordatorios:

- El cron resuelve cuenta por `id_sucursal` cuando existe una cuenta activa asociada.
- Si la cuenta de la sucursal no esta conectada, intenta enviar por `default`.
- La auditoria guarda `account_key`, `id_sucursal` y `numero_emisor` cuando aplica.
- Si falla un envio, se libera `recordatorio_lock` para no dejar el credito trabado.

## Manejo de sesiones perdidas

Cuando WhatsApp devuelve `loggedOut` (por ejemplo `401`), el servicio ahora:

- marca estado `session_lost`
- limpia `./sessions` automaticamente
- reintenta iniciar para generar nuevo QR

Estados SSE relevantes en `GET /qr`:

- `connected`
- `qr`
- `disconnected`
- `reconnecting` (incluye `attempt` y `delayMs`)
- `session_lost` (incluye `requiresQr: true`)

Variables opcionales:

- `WA_SESSION_PATH` (default `./sessions`)
- `WA_MULTI_SESSION_ROOT` (default `./sessions`)
- `WA_RECONNECT_DELAY_MS` (default `5000`)

## Seguridad para repositorio publico

Este proyecto ignora por defecto:

- `.env`
- `sessions/`
- `node_modules/`
- `*.log`

No publiques credenciales reales ni sesiones activas de WhatsApp.

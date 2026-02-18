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

## Ejecutar

```bash
npm start
```

Por defecto levanta en `http://localhost:3000`.

## Endpoints

- `GET /qr`: stream SSE con el QR de vinculacion
- `POST /send`: envio de mensaje
- `POST /run-cron-now`: ejecucion manual del cron

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
- `WA_RECONNECT_DELAY_MS` (default `5000`)

## Seguridad para repositorio publico

Este proyecto ignora por defecto:

- `.env`
- `sessions/`
- `node_modules/`
- `*.log`

No publiques credenciales reales ni sesiones activas de WhatsApp.

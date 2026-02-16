import winston from "winston";

const { combine, timestamp, json, errors, colorize, simple } = winston.format;

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: combine(
    timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    errors({ stack: true }),
    json(),
  ),
  transports: [
    new winston.transports.File({ filename: "error.log", level: "error" }),
  ],
});

if (process.env.NODE_ENV !== "test") {
  logger.add(
    new winston.transports.Console({
      format: combine(colorize(), timestamp({ format: "HH:mm:ss" }), simple()),
    }),
  );
}

export function logError(message, err, meta = {}) {
  if (err instanceof Error) {
    logger.error(message, {
      error: {
        message: err.message,
        stack: err.stack,
        name: err.name,
      },
      ...meta,
    });
    return;
  }

  if (err !== undefined) {
    logger.error(message, { error: err, ...meta });
    return;
  }

  logger.error(message, meta);
}

export default logger;

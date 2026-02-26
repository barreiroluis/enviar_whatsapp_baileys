import fs from "fs";
import path from "path";
import util from "util";
import winston from "winston";

const { combine, timestamp, json, errors, colorize, simple } = winston.format;

const LOG_DIR = path.join(process.cwd(), "logs");
const LATEST_LOG_PATH = path.join(LOG_DIR, "latest.log");
const LASTED_LOG_PATH = path.join(LOG_DIR, "lasted.log");
const HISTORY_PREFIX = "history-";
const HISTORY_FILE_REGEX = /^history-(\d{4}-\d{2}-\d{2})\.log$/;
const MAX_HISTORY_DAYS = 30;

const NOISY_PATTERNS = [
  "Closing session",
  "Removing old closed session",
  "SessionEntry",
  "pendingPreKey",
  "remoteIdentityKey",
  "baseKeyType",
  "\"class\":\"baileys\"",
  "identity changed",
];

let consolePatched = false;
let lastCleanupDay = "";

function formatDateTime(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function formatDay(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function ensureLogDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function getHistoryLogPath(date = new Date()) {
  return path.join(LOG_DIR, `${HISTORY_PREFIX}${formatDay(date)}.log`);
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable-meta]";
  }
}

function cleanupOldHistoryLogs() {
  const today = formatDay();
  if (lastCleanupDay === today) return;
  lastCleanupDay = today;

  ensureLogDir();

  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (MAX_HISTORY_DAYS - 1));

  for (const entry of fs.readdirSync(LOG_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue;

    const match = entry.name.match(HISTORY_FILE_REGEX);
    if (!match) continue;

    const fileDate = new Date(`${match[1]}T00:00:00`);
    if (Number.isNaN(fileDate.getTime())) continue;

    if (fileDate < cutoff) {
      fs.rmSync(path.join(LOG_DIR, entry.name), { force: true });
    }
  }
}

function writeAppLog(level, message) {
  ensureLogDir();
  cleanupOldHistoryLogs();

  const line = `[${formatDateTime()}] [${String(level).toUpperCase()}] ${message}`;
  fs.appendFileSync(LATEST_LOG_PATH, `${line}\n`, "utf8");
  fs.appendFileSync(LASTED_LOG_PATH, `${line}\n`, "utf8");
  fs.appendFileSync(getHistoryLogPath(), `${line}\n`, "utf8");
}

function shouldIgnoreConsoleMessage(message) {
  return NOISY_PATTERNS.some((pattern) => message.includes(pattern));
}

function patchConsoleMethod(methodName, originalMethod) {
  console[methodName] = (...args) => {
    const formatted = util.format(...args);

    if (shouldIgnoreConsoleMessage(formatted)) {
      return;
    }

    originalMethod.apply(console, args);
    writeAppLog(methodName, formatted);
  };
}

export function setupConsoleLogging() {
  if (consolePatched || process.env.NODE_ENV === "test") return;

  ensureLogDir();
  fs.writeFileSync(LATEST_LOG_PATH, "", "utf8");
  fs.writeFileSync(LASTED_LOG_PATH, "", "utf8");
  cleanupOldHistoryLogs();

  patchConsoleMethod("log", console.log);
  patchConsoleMethod("info", console.info);
  patchConsoleMethod("warn", console.warn);
  patchConsoleMethod("error", console.error);

  consolePatched = true;
}

ensureLogDir();

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: combine(
    timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    errors({ stack: true }),
    json(),
  ),
  transports: [
    new winston.transports.File({
      filename: path.join(LOG_DIR, "error.log"),
      level: "error",
    }),
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
    writeAppLog(
      "error",
      `${message} | ${err.name}: ${err.message} | meta=${safeStringify(meta)}`,
    );
    return;
  }

  if (err !== undefined) {
    logger.error(message, { error: err, ...meta });
    writeAppLog("error", `${message} | error=${safeStringify(err)} | meta=${safeStringify(meta)}`);
    return;
  }

  logger.error(message, meta);
  writeAppLog("error", `${message} | meta=${safeStringify(meta)}`);
}

export default logger;

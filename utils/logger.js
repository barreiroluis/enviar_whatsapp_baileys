import "dotenv/config";
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
function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

const MAX_HISTORY_DAYS = positiveInteger(process.env.LOG_RETENTION_DAYS, 7);
const MAX_LOG_BYTES = positiveInteger(process.env.LOG_MAX_SIZE_MB, 5) * 1024 * 1024;
const MAX_ERROR_FILES = positiveInteger(process.env.LOG_ERROR_MAX_FILES, 3);

// Keep recent complete lines, reading only the tail even for very large files.
function limitLogSize(filePath, incomingBytes = 0) {
  if (!fs.existsSync(filePath)) return;
  const size = fs.statSync(filePath).size;
  if (size + incomingBytes <= MAX_LOG_BYTES) return;

  const keepBytes = Math.max(0, Math.min(
    Math.floor(MAX_LOG_BYTES / 2), MAX_LOG_BYTES - incomingBytes,
  ));
  const tail = Buffer.alloc(Math.min(size, keepBytes));
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
  } finally {
    fs.closeSync(fd);
  }
  const newline = tail.indexOf(10);
  fs.writeFileSync(filePath, newline < 0 ? Buffer.alloc(0) : tail.subarray(newline + 1));
}

function appendBoundedLog(filePath, line) {
  let data = Buffer.from(`${line}\n`, "utf8");
  if (data.length > MAX_LOG_BYTES) {
    const marker = Buffer.from("… [mensaje truncado]\n", "utf8");
    const prefix = data.subarray(0, MAX_LOG_BYTES - marker.length)
      .toString("utf8").replace(/\uFFFD$/, "");
    data = Buffer.concat([Buffer.from(prefix), marker]);
  }
  limitLogSize(filePath, data.length);
  fs.appendFileSync(filePath, data);
}

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
    } else {
      limitLogSize(path.join(LOG_DIR, entry.name));
    }
  }
}

function writeAppLog(level, message) {
  ensureLogDir();
  cleanupOldHistoryLogs();

  const line = `[${formatDateTime()}] [${String(level).toUpperCase()}] ${message}`;
  appendBoundedLog(LATEST_LOG_PATH, line);
  appendBoundedLog(LASTED_LOG_PATH, line);
  appendBoundedLog(getHistoryLogPath(), line);
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
cleanupOldHistoryLogs();
limitLogSize(path.join(LOG_DIR, "error.log"));

// Also clean up when the service stays idle across midnight.
const cleanupTimer = setInterval(cleanupOldHistoryLogs, 60 * 60 * 1000);
cleanupTimer.unref();

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
      maxsize: MAX_LOG_BYTES,
      maxFiles: MAX_ERROR_FILES,
      tailable: true,
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

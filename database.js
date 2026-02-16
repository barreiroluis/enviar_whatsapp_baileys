import mysql from "mysql";
import { promisify } from "util";
import { logError } from "./utils/logger.js";

export const isMySQL = (process.env.DATABASE || "").toLowerCase() === "mysql";

let pool = null; // se crea on-demand

function createPool() {
  const database = {
    host: process.env.SQL_HOST,
    user: process.env.SQL_USER,
    password: process.env.SQL_PASS,
    database: process.env.SQL_DATABASE,
  };

  const p = mysql.createPool({
    ...database,
    connectionLimit: 50,
    waitForConnections: true,
    queueLimit: 0,
    connectTimeout: 10000,
    acquireTimeout: 10000,
  });

  // Chequeo inicial NO fatal
  p.getConnection((err, conn) => {
    if (err) {
      if (err.code === "PROTOCOL_CONNECTION_LOST") {
        logError("❌ Conexión con la DB fue cerrada.", err);
      } else if (err.code === "ER_CON_COUNT_ERROR") {
        logError("❌ Demasiadas conexiones simultáneas.", err);
      } else if (err.code === "ECONNREFUSED") {
        logError("❌ Conexión a la DB rechazada.", err);
      } else {
        logError("❌ Error al conectar", err);
      }
      return;
    }
    conn.release();
    console.log("✅ Pool MySQL listo.");
  });

  // Promisify helpers
  p.query = promisify(p.query);
  p.getConnection = promisify(p.getConnection);

  return p;
}

async function ensurePool() {
  if (!isMySQL) {
    throw new Error('Base de datos desactivada (DATABASE !== "mysql").');
  }
  if (!pool) pool = createPool();
  return pool;
}

export async function getConnectionWithRelease() {
  const p = await ensurePool();
  try {
    const connection = await p.getConnection();
    connection.query = promisify(connection.query);
    return connection;
  } catch (err) {
    logError("❌ Error al obtener conexión del pool", err);
    throw new Error("No se pudo obtener una conexión del pool.");
  }
}

export async function runQuery(query, params = []) {
  let connection;
  try {
    connection = await getConnectionWithRelease();
    return await connection.query(query, params);
  } catch (err) {
    logError("❌ Error ejecutando la consulta", err);
    throw err;
  } finally {
    if (connection) connection.release();
  }
}

// Getter opcional (solo lectura)
export function getPool() {
  return pool;
}

const express = require("express");
const cors = require("cors");

const { initializeApp, cert } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");
const { getDatabase } = require("firebase-admin/database");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

let messaging = null;
let db = null;

try {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const dbUrl = process.env.FIREBASE_DB_URL;

  if (sa && dbUrl) {
    initializeApp({
      credential: cert(JSON.parse(sa)),
      databaseURL: dbUrl,
    });
    messaging = getMessaging();
    db = getDatabase();
    console.log("Firebase Admin OK + RTDB OK");
  } else {
    console.log("Firebase Admin NO configurado: faltan FIREBASE_SERVICE_ACCOUNT_JSON o FIREBASE_DB_URL");
  }
} catch (e) {
  console.log("Error init Firebase Admin:", e.message);
}

app.get("/", (req, res) => res.send("OK - alarma server running"));

/**
 * Helpers DB (Realtime Database)
 */
function requireDb(res) {
  if (!db) {
    res.status(500).json({ ok: false, error: "Realtime DB no configurada (db=null)" });
    return false;
  }
  return true;
}

/**
 * Registro del móvil: guarda token por phone en RTDB
 * RTDB:
 *  devices/{phone} = { token, updatedAt }
 */
app.post("/register", async (req, res) => {
  const { phone, token } = req.body || {};
  if (!phone || !token) return res.status(400).json({ ok: false, error: "phone y token requeridos" });
  if (!requireDb(res)) return;

  try {
    const p = String(phone);
    await db.ref(`devices/${p}`).set({
      token: String(token),
      updatedAt: Date.now(),
    });
    console.log("Registrado en DB:", p);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/**
 * Ver lista de phones registrados (leyendo desde RTDB)
 */
app.get("/devices", async (req, res) => {
  if (!requireDb(res)) return;

  try {
    const snap = await db.ref("devices").get();
    const val = snap.val() || {};
    const phones = Object.keys(val);
    res.json({ ok: true, phones });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/**
 * Alerta real: el STM32 llamará esto (HTTP POST)
 * Body ejemplo:
 * { deviceId:"stm32-01", type:"INTRUSION", msg:"Botón pulsado", ts: 123456 }
 *
 * RTDB:
 *  history/{autoId} = { ts, deviceId, type, msg }
 */
app.post("/api/alert", async (req, res) => {
  const { deviceId, type, msg, ts } = req.body || {};
  if (!deviceId) return res.status(400).json({ ok: false, error: "deviceId requerido" });
  if (!requireDb(res)) return;
  if (!messaging) return res.status(500).json({ ok: false, error: "Firebase Admin Messaging no configurado" });

  const event = {
    ts: ts || Date.now(),
    deviceId: String(deviceId),
    type: type || "INTRUSION",
    msg: msg || "Intrusión detectada",
  };

  try {
    // 1) Guardar evento en DB
    await db.ref("history").push(event);
    console.log("ALERT guardada:", event);

    // 2) Leer tokens de DB
    const snap = await db.ref("devices").get();
    const devicesObj = snap.val() || {};
    const tokens = Object.values(devicesObj)
      .map((x) => x && x.token)
      .filter(Boolean);

    if (tokens.length === 0) {
      return res.json({ ok: true, sent: 0, note: "No hay móviles registrados" });
    }

    // 3) Enviar push a todos
    const response = await messaging.sendEachForMulticast({
      tokens,
      notification: {
        title: "🚨 ALARMA",
        body: `${event.msg} (${event.deviceId})`,
      },
      data: {
        type: event.type,
        deviceId: event.deviceId,
        ts: String(event.ts),
      },
    });

    res.json({
      ok: true,
      sent: response.successCount,
      failed: response.failureCount,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/**
 * Leer historial: devuelve últimos N (filtrado simple)
 * GET /api/history?limit=20
 */
app.get("/api/history", async (req, res) => {
  if (!requireDb(res)) return;

  const limit = Math.min(parseInt(req.query.limit || "20", 10) || 20, 100);

  try {
    const snap = await db.ref("history").limitToLast(limit).get();
    const val = snap.val() || {};
    // val es objeto {id: event,...} -> pasamos a array y ordenamos por ts desc
    const arr = Object.entries(val).map(([id, ev]) => ({ id, ...ev }));
    arr.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    res.json({ ok: true, history: arr });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.listen(PORT, () => console.log("Server listening on", PORT));


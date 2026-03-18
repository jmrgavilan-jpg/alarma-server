const express = require("express");
const cors = require("cors");

const { initializeApp, cert } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");
const { getDatabase } = require("firebase-admin/database");

const app = express();
app.use(cors());
app.use(express.json());

// Si llega un JSON mal formado, Express da "Bad Request" en HTML.
// Con esto lo convertimos a JSON para ver el motivo exacto.
app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({
      ok: false,
      error: "JSON inválido",
      details: err.message,
      contentType: req.headers["content-type"],
    });
  }
  next(err);
});

const PORT = process.env.PORT || 3000;

// Firebase Admin
let messaging = null;
let db = null;

try {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const dbUrl = process.env.FIREBASE_DB_URL;

  if (sa) {
    initializeApp({
      credential: cert(JSON.parse(sa)),
      ...(dbUrl ? { databaseURL: dbUrl } : {}),
    });

    messaging = getMessaging();

    if (dbUrl) {
      db = getDatabase();
      console.log("Firebase Admin OK + RTDB OK");
    } else {
      console.log("Firebase Admin OK (pero falta FIREBASE_DB_URL)");
    }
  } else {
    console.log("Firebase Admin NO configurado (falta FIREBASE_SERVICE_ACCOUNT_JSON)");
  }
} catch (e) {
  console.log("Error init Firebase Admin:", e.message);
}

// Salud
app.get("/", (req, res) => res.send("OK - alarma server running"));

// Helpers DB
async function saveDevice(phone, token) {
  if (!db) throw new Error("RTDB no configurada (FIREBASE_DB_URL)");
  await db.ref("devices").child(String(phone)).set({
    token: String(token),
    updatedAt: Date.now(),
  });
}

async function listPhones() {
  if (!db) throw new Error("RTDB no configurada (FIREBASE_DB_URL)");
  const snap = await db.ref("devices").get();
  const val = snap.val() || {};
  return Object.keys(val);
}

async function getAllTokens() {
  if (!db) throw new Error("RTDB no configurada (FIREBASE_DB_URL)");
  const snap = await db.ref("devices").get();
  const val = snap.val() || {};
  return Object.values(val)
    .map((x) => x && x.token)
    .filter(Boolean);
}

/**
 * ✅ FIX: historial correcto en RTDB
 * history/{autoId} = { ts, deviceId, type, msg }
 */
async function pushHistory(event) {
  if (!db) throw new Error("RTDB no configurada (FIREBASE_DB_URL)");
  await db.ref("history").push(event);
}

// Registrar móvil
app.post("/register", async (req, res) => {
  try {
    const { phone, token } = req.body || {};
    if (!phone || !token) {
      return res.status(400).json({ ok: false, error: "phone y token requeridos" });
    }
    await saveDevice(phone, token);
    console.log("Registrado en RTDB:", phone);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Ver móviles registrados
app.get("/devices", async (req, res) => {
  try {
    const phones = await listPhones();
    res.json({ ok: true, phones });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Endpoint real de alerta (STM32 llamará esto)
app.post("/api/alert", async (req, res) => {
  try {
    const { deviceId, type, msg, ts, lat, lon } = req.body || {};
    if (!deviceId) {
      return res.status(400).json({ ok: false, error: "deviceId requerido" });
    }

    const event = {
      ts: ts || Date.now(),
      deviceId: String(deviceId),
      type: type || "CAR_ALARM",
      msg: msg || "Alarma del coche activada",
      ...(lat !== undefined ? { lat: Number(lat) } : {}),
      ...(lon !== undefined ? { lon: Number(lon) } : {}),
    };

    await pushHistory(event);

    if (!messaging) {
      return res.status(500).json({ ok: false, error: "Firebase Admin no configurado" });
    }

    const tokens = await getAllTokens();
    if (tokens.length === 0) {
      return res.json({ ok: true, sent: 0, note: "No hay móviles registrados" });
    }

    const response = await messaging.sendEachForMulticast({
      tokens,
      data: {
        title: "🚗 ALARMA COCHE",
        body: event.msg,
        type: event.type,
        deviceId: event.deviceId,
        ts: String(event.ts),
        lat: lat !== undefined ? String(lat) : "",
        lon: lon !== undefined ? String(lon) : "",
      },
    });

    res.json({ ok: true, sent: response.successCount, failed: response.failureCount });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/**
 * ✅ FIX: leer historial de RTDB (objeto) -> array ordenado
 * GET /api/history?limit=20
 */
app.get("/api/history", async (req, res) => {
  try {
    if (!db) throw new Error("RTDB no configurada (FIREBASE_DB_URL)");

    const limit = Math.min(parseInt(req.query.limit || "20", 10) || 20, 100);

    const snap = await db.ref("history").limitToLast(limit).get();
    const val = snap.val() || {};

    // val = { id1: event1, id2: event2, ... } -> array
    const arr = Object.entries(val).map(([id, ev]) => ({ id, ...ev }));
    arr.sort((a, b) => (b.ts || 0) - (a.ts || 0));

    res.json({ ok: true, history: arr });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.listen(PORT, () => console.log("Server listening on", PORT));


const express = require("express");
const cors = require("cors");

const { initializeApp, cert } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");

const app = express();
app.use(cors());
app.use(express.json());

// Render te da el puerto por la variable PORT
const PORT = process.env.PORT || 3000;

/**
 * Para NO subir el JSON privado al repo, lo pondremos como variable de entorno.
 */
let messaging = null;
try {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (sa) {
    initializeApp({ credential: cert(JSON.parse(sa)) });
    messaging = getMessaging();
    console.log("Firebase Admin OK");
  } else {
    console.log("Firebase Admin NO configurado (falta FIREBASE_SERVICE_ACCOUNT_JSON)");
  }
} catch (e) {
  console.log("Error init Firebase Admin:", e.message);
}

// Endpoint de prueba para ver que el server está vivo
app.get("/", (req, res) => res.send("OK - alarma server running"));

// Ping para comprobar versión/estado
app.get("/api/ping", (req, res) => {
  res.json({ ok: true, time: Date.now(), hasFirebase: !!messaging });
});

// “Base de datos” simple en memoria (luego la cambiamos por DB real)
const devices = new Map(); // phone -> token

// Historial simple en memoria (luego lo pasamos a DB)
const history = []; // { ts, type, msg, deviceId }

// Registrar móvil (phone -> token)
app.post("/register", (req, res) => {
  const { phone, token } = req.body || {};
  if (!phone || !token) return res.status(400).json({ ok: false, error: "phone y token requeridos" });

  devices.set(String(phone), String(token));
  console.log("Registrado:", phone);
  res.json({ ok: true, count: devices.size });
});

// Ver teléfonos registrados
app.get("/devices", (req, res) => {
  res.json({ ok: true, phones: Array.from(devices.keys()) });
});

// Endpoint real de alerta (esto lo llamará el STM32 en el futuro)
app.post("/api/alert", async (req, res) => {
  const { deviceId, type, msg, ts, phone } = req.body || {};

  if (!deviceId) return res.status(400).json({ ok: false, error: "deviceId requerido" });

  const event = {
    ts: ts || Date.now(),
    deviceId: String(deviceId),
    type: type || "INTRUSION",
    msg: msg || "Intrusión detectada",
  };

  history.unshift(event);
  history.splice(50);
  console.log("ALERT:", event);

  if (!messaging) return res.status(500).json({ ok: false, error: "Firebase Admin no configurado" });

  // Si mandas phone, avisamos solo a ese. Si no, avisamos a todos.
  let tokens = [];
  if (phone) {
    const t = devices.get(String(phone));
    if (!t) return res.status(404).json({ ok: false, error: "phone no registrado" });
    tokens = [t];
  } else {
    tokens = Array.from(devices.values());
  }

  if (tokens.length === 0) return res.json({ ok: true, sent: 0, note: "No hay móviles registrados" });

  try {
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

    res.json({ ok: true, sent: response.successCount, failed: response.failureCount });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Ver historial
app.get("/api/history", (req, res) => {
  res.json({ ok: true, history });
});

// Enviar push de prueba (token o phone)
app.post("/send-test", async (req, res) => {
  const { token, phone, title, body } = req.body || {};
  if (!messaging) return res.status(500).json({ ok: false, error: "Firebase Admin no configurado" });

  const finalToken = token || (phone ? devices.get(String(phone)) : null);
  if (!finalToken) return res.status(400).json({ ok: false, error: "token o phone requerido (y que esté registrado)" });

  try {
    const msgId = await messaging.send({
      token: finalToken,
      notification: {
        title: title || "Prueba",
        body: body || "Hola desde Render",
      },
    });
    res.json({ ok: true, msgId });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.listen(PORT, () => console.log("Server listening on", PORT));

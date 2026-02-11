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
 * Para NO subir el JSON privado al repo, lo pondremos luego como variable de entorno.
 * De momento el servidor arrancará aunque Firebase no esté configurado.
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

// Enviar push de prueba
app.post("/send-test", async (req, res) => {
  const { token, title, body } = req.body || {};
  if (!messaging) return res.status(500).json({ ok: false, error: "Firebase Admin no configurado" });
  if (!token) return res.status(400).json({ ok: false, error: "token requerido" });

  try {
    const msgId = await messaging.send({
      token,
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

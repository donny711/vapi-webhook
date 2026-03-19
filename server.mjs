import express from "express";
import { JWT } from "google-auth-library";
import { createRequire } from "module";
import cron from "node-cron";

const require = createRequire(import.meta.url);
const { GoogleSpreadsheet } = require("google-spreadsheet");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public")); // servește crm.html din folderul public/

// ─── ENV ───────────────────────────────────────────────────────────────────
const SHEET_ID       = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB_NAME = process.env.GOOGLE_SHEET_TAB_NAME || "";
const CLIENT_EMAIL   = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY    = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const SMSLINK_ID     = process.env.SMSLINK_CONNECTION_ID;
const SMSLINK_PWD    = process.env.SMSLINK_PASSWORD;
const CLINIC_PHONE   = process.env.CLINIC_PHONE || "0316301589";

if (!SHEET_ID || !CLIENT_EMAIL || !PRIVATE_KEY) {
  console.error("Missing env vars: GOOGLE_SHEET_ID / GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY");
  process.exit(1);
}

// ─── GOOGLE SHEETS SETUP ───────────────────────────────────────────────────
const doc = new GoogleSpreadsheet(SHEET_ID);
let cachedSheet = null;
let sheetInitPromise = null;

const HEADERS = [
  "full_name",
  "phone_number",
  "pain_complaint",
  "caller_id_number",
  "has_exact_datetime",
  "appointment_datetime",
  "reminder_sent",
  "sedinte_ramase",
  "note_terapeut",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (e) { lastErr = e; await sleep(300 * 2 ** i); }
  }
  throw lastErr;
}

async function getSheet() {
  if (cachedSheet) return cachedSheet;
  if (!sheetInitPromise) {
    sheetInitPromise = (async () => {
      const auth = new JWT({
        email: CLIENT_EMAIL,
        key: PRIVATE_KEY,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      });
      doc.auth = auth;
      await doc.loadInfo();
      const sheet = SHEET_TAB_NAME
        ? doc.sheetsByTitle[SHEET_TAB_NAME]
        : doc.sheetsByIndex[0];
      if (!sheet) throw new Error("Worksheet not found.");
      await sheet.loadHeaderRow();
      if (!sheet.headerValues || sheet.headerValues.length === 0) {
        await sheet.setHeaderRow(HEADERS);
        await sheet.loadHeaderRow();
      }
      cachedSheet = sheet;
      return sheet;
    })();
  }
  return sheetInitPromise;
}

// ─── RECUNOASTERE PACIENT ──────────────────────────────────────────────────
async function cautaPacientDupaCaller(callerId) {
  if (!callerId) return null;
  try {
    const sheet = await getSheet();
    const rows = await sheet.getRows();
    const found = rows.find(
      (r) => r.get("caller_id_number") === callerId || r.get("phone_number") === callerId
    );
    if (!found) return null;
    return {
      full_name:            found.get("full_name"),
      pain_complaint:       found.get("pain_complaint"),
      appointment_datetime: found.get("appointment_datetime"),
    };
  } catch (err) {
    console.error("Eroare cautare pacient:", err.message);
    return null;
  }
}

// ─── SMS VIA SMSLINK ───────────────────────────────────────────────────────
function extrageOra(appointmentDatetime) {
  return appointmentDatetime.match(/T(\d{2}:\d{2})/)?.[1] || appointmentDatetime;
}

function normalizeazaTelefon(telefon) {
  let t = telefon.replace(/\D/g, "");
  if (t.startsWith("40")) t = "0" + t.slice(2);
  if (!t.startsWith("0")) t = "0" + t;
  return t;
}

async function trimiteReminderSMS(telefon, numePacient, dataOra) {
  if (!SMSLINK_ID || !SMSLINK_PWD) {
    console.warn("SMSLINK credentials lipsa, SMS netrimis.");
    return;
  }

  const telefonNormalizat = normalizeazaTelefon(telefon);
  const ora = extrageOra(dataOra);

  const mesaj =
    `Juni Performance: Buna ziua, ${numePacient}! Va asteptam maine ` +
    `la ora ${ora}. Reprogramari: ${CLINIC_PHONE}.`;

  const url =
    `https://secure.smslink.ro/sms/gateway/communicate/index.php` +
    `?connection_id=${encodeURIComponent(SMSLINK_ID)}` +
    `&password=${encodeURIComponent(SMSLINK_PWD)}` +
    `&to=${encodeURIComponent(telefonNormalizat)}` +
    `&message=${encodeURIComponent(mesaj)}`;

  try {
    const res  = await fetch(url);
    const text = await res.text();
    console.log(`SMS -> ${telefonNormalizat}: ${text}`);
    return text;
  } catch (err) {
    console.error("Eroare trimitere SMS:", err.message);
  }
}

// ─── CRON: remindere zilnice la 10:00 ─────────────────────────────────────
cron.schedule("0 10 * * *", async () => {
  console.log("[CRON] Verificare programari pentru maine...");
  try {
    const sheet = await getSheet();
    const rows  = await sheet.getRows();
    const maine = new Date();
    maine.setDate(maine.getDate() + 1);
    const dataMaine = maine.toISOString().split("T")[0];
    let trimise = 0;
    for (const row of rows) {
      const appointmentDatetime = row.get("appointment_datetime") || "";
      const reminderSent        = row.get("reminder_sent") || "";
      const telefon             = row.get("phone_number") || row.get("caller_id_number") || "";
      const numePacient         = row.get("full_name") || "pacient";
      if (!appointmentDatetime || reminderSent === "true") continue;
      if (!appointmentDatetime.includes(dataMaine)) continue;
      await trimiteReminderSMS(telefon, numePacient, appointmentDatetime);
      row.set("reminder_sent", "true");
      await withRetry(() => row.save());
      trimise++;
      await sleep(500);
    }
    console.log(`[CRON] Remindere trimise: ${trimise}`);
  } catch (err) {
    console.error("[CRON] Eroare:", err.message);
  }
});

// ─── CRM API ───────────────────────────────────────────────────────────────

// GET /pacienti — returnează toți pacienții unici (deduplicați după telefon)
app.get("/pacienti", async (_req, res) => {
  try {
    const sheet = await getSheet();
    const rows  = await sheet.getRows();

    const map = new Map();
    rows.forEach((row, i) => {
      const telefon = row.get("phone_number") || row.get("caller_id_number") || "";
      if (!map.has(telefon)) {
        map.set(telefon, {
          id:                   i + 1,
          nume:                 row.get("full_name") || "",
          telefon,
          diagnostic:           row.get("pain_complaint") || "",
          sedinte_ramase:       parseInt(row.get("sedinte_ramase") || "0"),
          note_terapeut:        row.get("note_terapeut") || "",
          appointment_datetime: row.get("appointment_datetime") || "",
          ultima_vizita:        row.get("appointment_datetime")?.split("T")[0] || "",
          _rowIndex:            i,
        });
      }
    });

    res.json(Array.from(map.values()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /pacienti/:telefon — programările unui pacient
app.get("/pacienti/:telefon", async (req, res) => {
  try {
    const sheet = await getSheet();
    const rows  = await sheet.getRows();
    const tel   = req.params.telefon;

    const programari = rows
      .filter(r => r.get("phone_number") === tel || r.get("caller_id_number") === tel)
      .map(r => ({
        data:   r.get("appointment_datetime")?.split("T")[0] || "",
        ora:    extrageOra(r.get("appointment_datetime") || ""),
        durere: r.get("pain_complaint") || "",
      }));

    res.json(programari);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /pacienti/:telefon — actualizează sedinte_ramase și note_terapeut
app.put("/pacienti/:telefon", async (req, res) => {
  try {
    const sheet = await getSheet();
    const rows  = await sheet.getRows();
    const tel   = req.params.telefon;
    const { sedinte_ramase, note_terapeut } = req.body;

    // Actualizează primul rând găsit cu telefonul respectiv
    const row = rows.find(r => r.get("phone_number") === tel || r.get("caller_id_number") === tel);
    if (!row) return res.status(404).json({ error: "Pacient negăsit" });

    if (sedinte_ramase !== undefined) row.set("sedinte_ramase", String(sedinte_ramase));
    if (note_terapeut  !== undefined) row.set("note_terapeut", note_terapeut);
    await withRetry(() => row.save());

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ROUTES ────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.status(200).send("ok"));

app.post("/vapi/webhook", (req, res) => {
  res.sendStatus(200);
  const type = req.body?.message?.type;
  if (type !== "end-of-call-report") return;
  const structuredData = req.body?.message?.analysis?.structuredData;
  if (!structuredData || typeof structuredData !== "object") return;
  if (structuredData.has_exact_datetime !== true) {
    console.log("Skipping row: has_exact_datetime is not true");
    return;
  }
  const call     = req.body?.message?.call;
  const callerId = call?.customer?.number ?? "";
  const row = {
    full_name:            structuredData.full_name ?? "",
    phone_number:         callerId || structuredData.phone_number || "",
    pain_complaint:       structuredData.pain_complaint ?? "",
    caller_id_number:     callerId || structuredData.caller_id_number || "",
    has_exact_datetime:   true,
    appointment_datetime: structuredData.appointment_datetime ?? "",
    reminder_sent:        "false",
    sedinte_ramase:       "",
    note_terapeut:        "",
  };
  (async () => {
    try {
      const pacientExistent = await cautaPacientDupaCaller(callerId);
      if (pacientExistent) {
        console.log(`Pacient recurent recunoscut: ${pacientExistent.full_name} (${callerId})`);
      } else {
        console.log(`Pacient nou: ${row.full_name} (${callerId})`);
      }
      const sheet = await getSheet();
      await withRetry(() => sheet.addRow(row));
      console.log("Date adaugate in Google Sheet");
    } catch (err) {
      const msg = err?.message || err;
      if (String(msg).includes("The caller does not have permission")) {
        console.error("Permission error: share the Google Sheet with GOOGLE_CLIENT_EMAIL as Editor.");
        return;
      }
      console.error("Eroare scriere in Google Sheet:", msg);
    }
  })();
});

// ─── TEST REMINDERS ────────────────────────────────────────────────────────
app.get("/test-reminders", async (_req, res) => {
  try {
    const sheet = await getSheet();
    const rows  = await sheet.getRows();
    const maine = new Date();
    maine.setDate(maine.getDate() + 1);
    const dataMaine = maine.toISOString().split("T")[0];
    let trimise = 0;
    for (const row of rows) {
      const appointmentDatetime = row.get("appointment_datetime") || "";
      const reminderSent        = row.get("reminder_sent") || "";
      const telefon             = row.get("phone_number") || row.get("caller_id_number") || "";
      const numePacient         = row.get("full_name") || "pacient";
      if (!appointmentDatetime || reminderSent === "true") continue;
      if (!appointmentDatetime.includes(dataMaine)) continue;
      await trimiteReminderSMS(telefon, numePacient, appointmentDatetime);
      row.set("reminder_sent", "true");
      await withRetry(() => row.save());
      trimise++;
      await sleep(500);
    }
    res.json({ success: true, trimise });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── START ─────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

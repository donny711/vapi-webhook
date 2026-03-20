import express from "express";
import { JWT } from "google-auth-library";
import { createRequire } from "module";
import cron from "node-cron";

const require = createRequire(import.meta.url);
const { GoogleSpreadsheet } = require("google-spreadsheet");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

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

const doc = new GoogleSpreadsheet(SHEET_ID);
let cachedSheet = null;
let sheetInitPromise = null;

const HEADERS = [
  "full_name", "phone_number", "pain_complaint", "caller_id_number",
  "has_exact_datetime", "appointment_datetime", "reminder_sent",
  "sedinte_ramase", "note_terapeut", "urgent", "tip_serviciu",
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
    const rows  = await sheet.getRows();
    const found = rows.find(
      (r) => r.get("caller_id_number") === callerId || r.get("phone_number") === callerId
    );
    if (!found) return null;
    return {
      full_name:            found.get("full_name"),
      pain_complaint:       found.get("pain_complaint"),
      appointment_datetime: found.get("appointment_datetime"),
      tip_serviciu:         found.get("tip_serviciu") || "fizioterapie",
    };
  } catch (err) {
    console.error("Eroare cautare pacient:", err.message);
    return null;
  }
}

// ─── SMS ───────────────────────────────────────────────────────────────────
function extrageOra(dt) { return dt.match(/T(\d{2}:\d{2})/)?.[1] || dt; }

function normalizeazaTelefon(telefon) {
  let t = telefon.replace(/\D/g, "");
  if (t.startsWith("40")) t = "0" + t.slice(2);
  if (!t.startsWith("0")) t = "0" + t;
  return t;
}

async function trimiteReminderSMS(telefon, numePacient, dataOra) {
  if (!SMSLINK_ID || !SMSLINK_PWD) { console.warn("SMSLINK credentials lipsa."); return; }
  const tel = normalizeazaTelefon(telefon);
  const ora = extrageOra(dataOra);
  const mesaj = `Juni Performance: Buna ziua, ${numePacient}! Va asteptam maine la ora ${ora}. Reprogramari: ${CLINIC_PHONE}.`;
  const url = `https://secure.smslink.ro/sms/gateway/communicate/index.php` +
    `?connection_id=${encodeURIComponent(SMSLINK_ID)}&password=${encodeURIComponent(SMSLINK_PWD)}` +
    `&to=${encodeURIComponent(tel)}&message=${encodeURIComponent(mesaj)}`;
  try {
    const res  = await fetch(url);
    const text = await res.text();
    console.log(`SMS -> ${tel}: ${text}`);
  } catch (err) { console.error("Eroare SMS:", err.message); }
}

// ─── CRON ──────────────────────────────────────────────────────────────────
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
      const dt          = row.get("appointment_datetime") || "";
      const reminderSent = row.get("reminder_sent") || "";
      const telefon     = row.get("phone_number") || row.get("caller_id_number") || "";
      const nume        = row.get("full_name") || "pacient";
      if (!dt || reminderSent === "true") continue;
      if (!dt.includes(dataMaine)) continue;
      await trimiteReminderSMS(telefon, nume, dt);
      row.set("reminder_sent", "true");
      await withRetry(() => row.save());
      trimise++;
      await sleep(500);
    }
    console.log(`[CRON] Remindere trimise: ${trimise}`);
  } catch (err) { console.error("[CRON] Eroare:", err.message); }
});

// ─── CRM API ───────────────────────────────────────────────────────────────
app.get("/pacienti", async (_req, res) => {
  try {
    const sheet = await getSheet();
    const rows  = await sheet.getRows();
    const map   = new Map();
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
          urgent:               row.get("urgent") === "true",
          tip_serviciu:         row.get("tip_serviciu") || "fizioterapie",
          appointment_datetime: row.get("appointment_datetime") || "",
          ultima_vizita:        row.get("appointment_datetime")?.split("T")[0] || "",
        });
      }
    });
    res.json(Array.from(map.values()));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/pacienti/:telefon", async (req, res) => {
  try {
    const sheet = await getSheet();
    const rows  = await sheet.getRows();
    const tel   = req.params.telefon;
    const { sedinte_ramase, note_terapeut, urgent, tip_serviciu } = req.body;
    const row = rows.find(r => r.get("phone_number") === tel || r.get("caller_id_number") === tel);
    if (!row) return res.status(404).json({ error: "Pacient negăsit" });
    if (sedinte_ramase !== undefined) row.set("sedinte_ramase", String(sedinte_ramase));
    if (note_terapeut  !== undefined) row.set("note_terapeut", note_terapeut);
    if (urgent         !== undefined) row.set("urgent", String(urgent));
    if (tip_serviciu   !== undefined) row.set("tip_serviciu", tip_serviciu);
    await withRetry(() => row.save());
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ROUTES ────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.status(200).send("ok"));

app.post("/vapi/webhook", async (req, res) => {
  const type     = req.body?.message?.type;
  const call     = req.body?.message?.call;
  const callerId = call?.customer?.number ?? "";

  // ── Recunoaștere pacient la începutul apelului ──────────────────────────
  if (type === "assistant-request") {
    res.setHeader("Content-Type", "application/json");
    try {
      const pacient = await cautaPacientDupaCaller(callerId);

      if (!pacient) {
        return res.json({
          assistant: {
            firstMessage: "Buna ziua! Ati sunat la Juni Performance. Cu ce va pot ajuta?"
          }
        });
      }

      const tip  = pacient.tip_serviciu || "fizioterapie";
      const nume = pacient.full_name?.split(" ")[0] || "";
      const dataEval = pacient.appointment_datetime ? new Date(pacient.appointment_datetime) : null;
      const eEvaluareFinalizata = tip === "evaluare" && dataEval && dataEval < new Date();

      let firstMessage;
      if (eEvaluareFinalizata) {
        firstMessage = `Bine ai revenit, ${nume}! Cum a decurs evaluarea? Vrei sa programam o sedinta de fizioterapie sau kinetoterapie?`;
      } else {
        firstMessage = `Bine ai revenit, ${nume}! Ai nevoie de informatii sau vrei sa programam urmatoarea sedinta de ${tip}?`;
      }

      console.log(`Pacient recunoscut la apel: ${pacient.full_name} (${callerId}) — ${tip}`);
      return res.json({ assistant: { firstMessage } });

    } catch (err) {
      console.error("Eroare assistant-request:", err.message);
      return res.json({
        assistant: {
          firstMessage: "Buna ziua! Ati sunat la Juni Performance. Cu ce va pot ajuta?"
        }
      });
    }
  }

  // ── End of call report ──────────────────────────────────────────────────
  res.sendStatus(200);

  if (type !== "end-of-call-report") return;

  const structuredData = req.body?.message?.analysis?.structuredData;
  if (!structuredData || typeof structuredData !== "object") return;
  if (structuredData.has_exact_datetime !== true) {
    console.log("Skipping row: has_exact_datetime is not true");
    return;
  }

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
    urgent:               "false",
    tip_serviciu:         structuredData.tip_serviciu ?? "fizioterapie",
  };

  (async () => {
    try {
      const pacientExistent = await cautaPacientDupaCaller(callerId);
      if (pacientExistent) {
        console.log(`Pacient recurent: ${pacientExistent.full_name} (${callerId})`);
      } else {
        console.log(`Pacient nou: ${row.full_name} (${callerId})`);
      }
      const sheet = await getSheet();
      await withRetry(() => sheet.addRow(row));
      console.log("Date adaugate in Google Sheet");
    } catch (err) {
      const msg = err?.message || err;
      if (String(msg).includes("The caller does not have permission")) {
        console.error("Permission error: share Sheet with GOOGLE_CLIENT_EMAIL as Editor.");
        return;
      }
      console.error("Eroare scriere Sheet:", msg);
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
      const dt          = row.get("appointment_datetime") || "";
      const reminderSent = row.get("reminder_sent") || "";
      const telefon     = row.get("phone_number") || row.get("caller_id_number") || "";
      const nume        = row.get("full_name") || "pacient";
      if (!dt || reminderSent === "true") continue;
      if (!dt.includes(dataMaine)) continue;
      await trimiteReminderSMS(telefon, nume, dt);
      row.set("reminder_sent", "true");
      await withRetry(() => row.save());
      trimise++;
      await sleep(500);
    }
    res.json({ success: true, trimise });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── START ─────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

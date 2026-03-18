import express from "express";
import { JWT } from "google-auth-library";
import { createRequire } from "module";
import cron from "node-cron";

const require = createRequire(import.meta.url);
const { GoogleSpreadsheet } = require("google-spreadsheet");

const app = express();
app.use(express.json({ limit: "2mb" }));

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
  "full_name",
  "phone_number",
  "pain_complaint",
  "caller_id_number",
  "has_exact_datetime",
  "appointment_datetime",
  "reminder_sent",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await sleep(300 * 2 ** i);
    }
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

async function trimiteReminderSMS(telefon, numePacient, dataOra) {
  if (!SMSLINK_ID || !SMSLINK_PWD) {
    console.warn("SMSLINK credentials lipsa, SMS netrimis.");
    return;
  }

  let telefonNormalizat = telefon.replace(/\D/g, "");
  if (telefonNormalizat.startsWith("40")) {
    telefonNormalizat = "0" + telefonNormalizat.slice(2);
  }
  if (!telefonNormalizat.startsWith("0")) {
    telefonNormalizat = "0" + telefonNormalizat;
  }

  const mesaj =
    `Juni Performance: Buna ziua, ${numePacient}! Va asteptam maine ` +
    `la ${dataOra}. Reprogramari: ${CLINIC_PHONE}.`;

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

      const ora = appointmentDatetime.split(" ")[1] || appointmentDatetime;
      await trimiteReminderSMS(telefon, numePacient, ora);

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

const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

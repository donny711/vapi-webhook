import express from "express";
import { JWT } from "google-auth-library";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { GoogleSpreadsheet } = require("google-spreadsheet");

const app = express();
app.use(express.json({ limit: "2mb" }));

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB_NAME = process.env.GOOGLE_SHEET_TAB_NAME || "";
const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

if (!SHEET_ID || !CLIENT_EMAIL || !PRIVATE_KEY) {
  console.error(
    "Missing env vars: GOOGLE_SHEET_ID / GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY"
  );
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

      if (!sheet) {
        throw new Error(
          "Worksheet not found. Set GOOGLE_SHEET_TAB_NAME to an existing tab name."
        );
      }

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

app.get("/health", (_req, res) => res.status(200).send("ok"));

app.post("/vapi/webhook", (req, res) => {
  // reply immediately to avoid timeouts
  res.sendStatus(200);

  const type = req.body?.message?.type;
  if (type !== "end-of-call-report") return;

  const structuredData = req.body?.message?.analysis?.structuredData;
  if (!structuredData || typeof structuredData !== "object") return;

  // ✅ Only proceed if appointment has exact datetime
  if (structuredData.has_exact_datetime !== true) {
    console.log("Skipping row: has_exact_datetime is not true");
    return;
  }

  // ✅ Caller ID from Vapi metadata
  const call = req.body?.message?.call;
  const callerId = call?.customer?.number ?? "";

  const row = {
    full_name: structuredData.full_name ?? "",
    phone_number: callerId || structuredData.phone_number || "",
    pain_complaint: structuredData.pain_complaint ?? "",
    caller_id_number: callerId || structuredData.caller_id_number || "",
    has_exact_datetime: true,
    appointment_datetime: structuredData.appointment_datetime ?? "",
  };

  (async () => {
    try {
      const sheet = await getSheet();
      await withRetry(() => sheet.addRow(row));
      console.log("Data added to Google Sheet");
    } catch (err) {
      const msg = err?.message || err;

      if (String(msg).includes("The caller does not have permission")) {
        console.error(
          "Permission error: share the Google Sheet with GOOGLE_CLIENT_EMAIL as Editor."
        );
        return;
      }

      console.error("Error writing to Google Sheet:", msg);
    }
  })();
});

const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

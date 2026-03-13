"use strict";

const express = require("express");
const { JWT } = require("google-auth-library");

// --- google-spreadsheet import compat (v4/v5, CJS/ESM builds) ---
const gsModule = require("google-spreadsheet");
const GoogleSpreadsheet =
  gsModule.GoogleSpreadsheet || gsModule.default || gsModule;

if (typeof GoogleSpreadsheet !== "function") {
  throw new Error(
    "google-spreadsheet import failed: GoogleSpreadsheet is not a constructor. " +
      "Check google-spreadsheet version / module export."
  );
}

const app = express();
app.use(express.json({ limit: "2mb" }));

// ---- ENV ----
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB_NAME = process.env.GOOGLE_SHEET_TAB_NAME || ""; // optional
const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY_RAW = process.env.GOOGLE_PRIVATE_KEY || "";
const PRIVATE_KEY = PRIVATE_KEY_RAW.replace(/\\n/g, "\n");

const REQUIRED_ENVS = ["GOOGLE_SHEET_ID", "GOOGLE_CLIENT_EMAIL", "GOOGLE_PRIVATE_KEY"];
for (const k of REQUIRED_ENVS) {
  if (!process.env[k]) {
    console.error(`Missing env var: ${k}`);
  }
}
if (!SHEET_ID || !CLIENT_EMAIL || !PRIVATE_KEY) process.exit(1);

console.log("Booting webhook server");
try {
  console.log(
    "google-spreadsheet version:",
    require("google-spreadsheet/package.json").version
  );
} catch {
  console.log("google-spreadsheet version: (unknown)");
}

// ---- Google Sheet init (cached) ----
const doc = new GoogleSpreadsheet(SHEET_ID);

let cachedSheet = null;
let sheetInitPromise = null;

// define the headers we expect in the sheet:
const HEADERS = [
  "full_name",
  "phone_number",
  "pain_complaint",
  "caller_id_number",
  "has_exact_datetime",
  "appointment_datetime",
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry(fn, { retries = 3, baseDelayMs = 300 } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const delay = baseDelayMs * Math.pow(2, i);
      await sleep(delay);
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

      // v5 uses setAuth; older versions had useServiceAccountAuth
      if (typeof doc.setAuth === "function") {
        await doc.setAuth(auth);
      } else if (typeof doc.useServiceAccountAuth === "function") {
        // fallback for older versions
        await doc.useServiceAccountAuth(auth);
      } else {
        throw new Error(
          "No supported auth method found on doc (expected setAuth or useServiceAccountAuth)."
        );
      }

      await doc.loadInfo();

      let sheet = null;

      if (SHEET_TAB_NAME) {
        sheet = doc.sheetsByTitle[SHEET_TAB_NAME];
        if (!sheet) {
          const available = Object.keys(doc.sheetsByTitle || {});
          throw new Error(
            `Sheet tab not found: "${SHEET_TAB_NAME}". Available: ${available.join(
              ", "
            )}`
          );
        }
      } else {
        sheet = doc.sheetsByIndex[0];
        if (!sheet) throw new Error("No worksheets found in spreadsheet.");
      }

      // Ensure header row exists and matches our columns
      // If the sheet is empty, set header row.
      await withRetry(async () => {
        // In google-spreadsheet v5, setHeaderRow exists on worksheet
        if (typeof sheet.setHeaderRow === "function") {
          // Only set headers if sheet looks uninitialized (no headerValues)
          if (!sheet.headerValues || sheet.headerValues.length === 0) {
            await sheet.setHeaderRow(HEADERS);
          }
        }
      });

      cachedSheet = sheet;
      return sheet;
    })();
  }

  return sheetInitPromise;
}

// ---- Helpers ----
function normalizeEvent(body) {
  // Some setups send { message: {...} } already, others send the event root.
  if (body?.message?.type) return body;
  if (body?.type && body?.call) return { message: body };
  return body;
}

function asString(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  return String(v);
}

// ---- Routes ----
app.get("/health", (_req, res) => res.status(200).send("ok"));

app.post("/vapi/webhook", (req, res) => {
  // Always respond immediately to avoid Vapi timeouts
  res.sendStatus(200);

  const event = normalizeEvent(req.body);
  const type = event?.message?.type;
  console.log("Webhook received:", type);

  if (type !== "end-of-call-report") return;

  const structuredData = event?.message?.analysis?.structuredData;
  if (!structuredData || typeof structuredData !== "object") {
    console.log("No structuredData found; skipping sheet write");
    return;
  }

  const row = {
    full_name: asString(structuredData.full_name),
    phone_number: asString(structuredData.phone_number),
    pain_complaint: asString(structuredData.pain_complaint),
    caller_id_number: asString(structuredData.caller_id_number),
    has_exact_datetime:
      typeof structuredData.has_exact_datetime === "boolean"
        ? structuredData.has_exact_datetime
        : asString(structuredData.has_exact_datetime),
    appointment_datetime: asString(structuredData.appointment_datetime),
  };

  (async () => {
    try {
      const sheet = await getSheet();

      await withRetry(async () => {
        await sheet.addRow(row);
      });

      console.log("Data added to Google Sheet");
    } catch (err) {
      const msg = err?.message || err;

      // Common “permissions” hint
      if (String(msg).includes("The caller does not have permission")) {
        console.error(
          "Error writing to Google Sheet: Service account has no access. " +
            "Share the Google Sheet with GOOGLE_CLIENT_EMAIL as Editor."
        );
        return;
      }

      console.error("Error writing to Google Sheet:", msg);
    }
  })();
});

// ---- Start ----
const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

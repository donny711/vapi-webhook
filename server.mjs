import express from "express";
import { JWT } from "google-auth-library";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// Load google-spreadsheet via require to avoid ESM export ambiguity
const gs = require("google-spreadsheet");
const GoogleSpreadsheet =
  gs.GoogleSpreadsheet || gs.default?.GoogleSpreadsheet || gs.default || gs;

if (typeof GoogleSpreadsheet !== "function") {
  console.error("google-spreadsheet export keys:", Object.keys(gs));
  throw new Error("GoogleSpreadsheet constructor not found in google-spreadsheet exports.");
}

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

console.log("Booting webhook server");
console.log("doc constructor ok:", typeof GoogleSpreadsheet === "function");

const doc = new GoogleSpreadsheet(SHEET_ID);

console.log("doc auth methods:", {
  setAuth: typeof doc.setAuth,
  useServiceAccountAuth: typeof doc.useServiceAccountAuth,
});

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

      if (typeof doc.setAuth === "function") {
        await doc.setAuth(auth);
      } else if (typeof doc.useServiceAccountAuth === "function") {
        await doc.useServiceAccountAuth(auth);
      } else {
        throw new Error(
          "No supported auth method found on doc (expected setAuth or useServiceAccountAuth)."
        );
      }

      await doc.loadInfo();

      const sheet = SHEET_TAB_NAME
        ? doc.sheetsByTitle[SHEET_TAB_NAME]
        : doc.sheetsByIndex[0];

      if (!sheet) {
        throw new Error(
          "Worksheet not found. Set GOOGLE_SHEET_TAB_NAME to an existing tab name."
        );
      }

      if (
        (!sheet.headerValues || sheet.headerValues.length === 0) &&
        typeof sheet.setHeaderRow === "function"
      ) {
        await sheet.setHeaderRow(HEADERS);
      }

      cachedSheet = sheet;
      return sheet;
    })();
  }

  return sheetInitPromise;
}

app.get("/health", (_req, res) => res.status(200).send("ok"));

app.post("/vapi/webhook", (req, res) => {
  res.sendStatus(200);

  const type = req.body?.message?.type;
  console.log("Webhook received:", type);

  if (type !== "end-of-call-report") return;

  const structuredData = req.body?.message?.analysis?.structuredData;
  if (!structuredData || typeof structuredData !== "object") {
    console.log("No structuredData; skipping");
    return;
  }

  const row = {
    full_name: structuredData.full_name ?? "",
    phone_number: structuredData.phone_number ?? "",
    pain_complaint: structuredData.pain_complaint ?? "",
    caller_id_number: structuredData.caller_id_number ?? "",
    has_exact_datetime:
      typeof structuredData.has_exact_datetime === "boolean"
        ? structuredData.has_exact_datetime
        : "",
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

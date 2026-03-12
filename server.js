const express = require("express");
const { GoogleSpreadsheet } = require("google-spreadsheet");

const app = express();
app.use(express.json({ limit: "2mb" }));

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
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

async function getSheet() {
  if (cachedSheet) return cachedSheet;
  if (!sheetInitPromise) {
    sheetInitPromise = (async () => {
      await doc.useServiceAccountAuth({
        client_email: CLIENT_EMAIL,
        private_key: PRIVATE_KEY,
      });
      await doc.loadInfo();
      cachedSheet = doc.sheetsByIndex[0];
      return cachedSheet;
    })();
  }
  return sheetInitPromise;
}

app.post("/vapi/webhook", (req, res) => {
  // Respond immediately so Vapi doesn't timeout
  res.sendStatus(200);

  const event = req.body;
  const type = event?.message?.type;
  console.log("Webhook received:", type);

  if (type !== "end-of-call-report") return;

  const structuredData = event?.message?.analysis?.structuredData;
  if (!structuredData) {
    console.log("No structuredData in end-of-call-report");
    return;
  }

  // Fire-and-forget async write
  (async () => {
    try {
      const sheet = await getSheet();

      await sheet.addRow({
        full_name: structuredData.full_name || "",
        phone_number: structuredData.phone_number || "",
        pain_complaint: structuredData.pain_complaint || "",
        caller_id_number: structuredData.caller_id_number || "",
        has_exact_datetime:
          typeof structuredData.has_exact_datetime === "boolean"
            ? structuredData.has_exact_datetime
            : "",
        appointment_datetime: structuredData.appointment_datetime || "",
      });

      console.log("Data added to Google Sheet:", structuredData);
    } catch (err) {
      console.error("Error writing to Google Sheet:", err?.message || err);
    }
  })();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

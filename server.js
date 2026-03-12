const express = require("express");
const { GoogleSpreadsheet } = require("google-spreadsheet");

const app = express();
app.use(express.json());

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

if (!SHEET_ID || !CLIENT_EMAIL || !PRIVATE_KEY) {
  console.error("Missing env vars: GOOGLE_SHEET_ID / GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY");
  process.exit(1);
}

const doc = new GoogleSpreadsheet(SHEET_ID);

async function accessSheet() {
  await doc.useServiceAccountAuth({
    client_email: CLIENT_EMAIL,
    private_key: PRIVATE_KEY,
  });
  await doc.loadInfo();
  return doc.sheetsByIndex[0];
}

app.post("/vapi/webhook", (req, res) => {
  const event = req.body;
  res.status(200).send("ok");

  if (event.message?.type === "end-of-call-report") {
    const structuredData = event.message?.call?.analysis?.structuredData;
    if (!structuredData) return;

    (async () => {
      try {
        const sheet = await accessSheet();
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
      } catch (err) {
        console.error("Error writing to Google Sheet:", err);
      }
    })();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

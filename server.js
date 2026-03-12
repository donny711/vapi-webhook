const express = require("express");
const { GoogleSpreadsheet } = require("google-spreadsheet");

const app = express();
app.use(express.json());

// Environment variables
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n");

const doc = new GoogleSpreadsheet(SHEET_ID);

async function accessSheet() {
  await doc.useServiceAccountAuth({
    client_email: CLIENT_EMAIL,
    private_key: PRIVATE_KEY,
  });
  await doc.loadInfo();
  return doc.sheetsByIndex[0]; // first sheet
}

app.post("/vapi/webhook", (req, res) => {
  const event = req.body;

  // Respond immediately to Vapi
  res.status(200).send("ok");

  // Do the Google Sheet write asynchronously
  if (event.message?.type === "end-of-call-report") {
    const structuredData = event.analysis?.structuredData;

    (async () => {
      try {
        const sheet = await accessSheet();
        await sheet.addRow(structuredData);
        console.log("Data added to Google Sheet:", structuredData);
      } catch (err) {
        console.error("Error writing to Google Sheet:", err);
      }
    })();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
app.post("/vapi/webhook", (req, res) => {
  const event = req.body;

  // Respond immediately to Vapi
  res.status(200).send("ok");

  // Do the Google Sheet write asynchronously
  if (event.message?.type === "end-of-call-report") {
    const structuredData = event.message?.call?.analysis?.structuredData;

    if (!structuredData) {
      console.log("No structuredData found on end-of-call-report");
      return;
    }

    (async () => {
      try {
        const sheet = await accessSheet();

        // Optional: map fields explicitly so headers match
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
        console.error("Error writing to Google Sheet:", err);
      }
    })();
  }
});

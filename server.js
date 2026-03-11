const express = require("express");

const app = express();
app.use(express.json());

// Vapi webhook endpoint
app.post("/vapi/webhook", (req, res) => {
  const event = req.body;

  console.log("Webhook received:");

  if (event.message?.type === "end-of-call-report") {
    const callId = event.call?.id;
    const structuredData = event.analysis?.structuredData;

    console.log("Call ID:", callId);
    console.log("Structured Data:", structuredData);
  }

  res.status(200).send("ok");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
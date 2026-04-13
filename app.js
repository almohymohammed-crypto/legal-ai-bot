const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

async function sendTelegramMessage(chatId, text) {
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    chat_id: chatId,
    text,
  });
}

function headers() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
  };
}

app.post("/webhook", async (req, res) => {
  const message = req.body.message;

  if (!message || !message.text) return res.sendStatus(200);

  const chatId = message.chat.id;
  const text = message.text;

  try {
    // 🔹 OpenAI
    const ai = await axios.post(
      "https://api.openai.com/v1/responses",
      {
        model: "gpt-4.1-mini",
        input: `أنت محامي سعودي. أجب بشكل واضح:\n${text}`,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
      }
    );

    const reply = ai.data.output[0].content[0].text;

    // 🔹 حفظ في Supabase
    await axios.post(
      `${SUPABASE_URL}/rest/v1/messages`,
      {
        question: text,
        answer: reply,
      },
      { headers: headers() }
    );

    // 🔹 إرسال الرد
    await sendTelegramMessage(chatId, reply);

    res.sendStatus(200);
  } catch (err) {
    console.error(err.response?.data || err.message);

    await sendTelegramMessage(chatId, "❌ خطأ في النظام، سيتم إصلاحه");

    res.sendStatus(200);
  }
});

app.listen(10000, () => {
  console.log("Running...");
});

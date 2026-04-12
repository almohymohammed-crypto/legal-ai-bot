const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

app.post("/webhook", async (req, res) => {
  const message = req.body.message;

  if (!message || !message.text) {
    return res.sendStatus(200);
  }

  const chatId = message.chat.id;
  const text = message.text;
  const telegramId = String(message.from.id);
  const name =
    [message.from.first_name, message.from.last_name]
      .filter(Boolean)
      .join(" ")
      .trim() || "Unknown";

  try {
    // 1) احفظ أو حدّث المستخدم
    await axios.post(
      `${SUPABASE_URL}/rest/v1/users`,
      {
        telegram_id: telegramId,
        name: name
      },
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates"
        }
      }
    );

    // 2) هات المستخدم من قاعدة البيانات عشان نجيب id الداخلي
    const userRes = await axios.get(
      `${SUPABASE_URL}/rest/v1/users?telegram_id=eq.${telegramId}&select=id`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`
        }
      }
    );

    const user = userRes.data[0];

    // 3) اسأل OpenAI
    const openaiResponse = await axios.post(
      "https://api.openai.com/v1/responses",
      {
        model: "gpt-4.1-mini",
        input: `
أنت مستشار قانوني متخصص في نظام العمل السعودي.

أجب على السؤال التالي بشكل احترافي وواضح.

التعليمات:
- ابدأ بجواب مباشر
- ثم شرح مبسط
- إذا أمكن اذكر رقم المادة
- لا تخترع معلومات
- إذا لم تكن متأكدًا فقل ذلك بوضوح
- اختم بـ: "هذه معلومات عامة وليست استشارة قانونية رسمية"

السؤال:
${text}
`
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const reply = openaiResponse.data.output[0].content[0].text;

    // 4) احفظ السؤال والجواب
    if (user && user.id) {
      await axios.post(
        `${SUPABASE_URL}/rest/v1/messages`,
        {
          user_id: user.id,
          question: text,
          answer: reply
        },
        {
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            "Content-Type": "application/json"
          }
        }
      );
    }

    // 5) أرسل الرد إلى تيليجرام
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        chat_id: chatId,
        text: reply
      }
    );

    return res.sendStatus(200);
  } catch (error) {
    console.error(
      error.response ? error.response.data : error.message
    );
    return res.sendStatus(500);
  }
});

app.get("/", (req, res) => {
  res.send("Bot is running 🚀");
});

app.listen(10000, () => {
  console.log("Server running on port 10000");
});

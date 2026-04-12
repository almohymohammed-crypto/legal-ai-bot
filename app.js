const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.post("/webhook", async (req, res) => {
  const message = req.body.message;

  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const text = message.text;

  try {
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
- إذا ما تعرف، قل لا أعلم
- اختم بـ: "هذه معلومات عامة وليست استشارة قانونية رسمية"

السؤال:
${text}
`,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const reply =
      openaiResponse.data.output[0].content[0].text;

    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        chat_id: chatId,
        text: reply,
      }
    );
  } catch (error) {
    console.log(error.message);
  }

  res.sendStatus(200);
});

app.get("/", (req, res) => {
  res.send("Bot is running 🚀");
});

app.listen(10000, () => {
  console.log("Server running on port 10000");
});

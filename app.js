const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// منع التكرار في الذاكرة
const processedMessages = new Set();

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

async function saveMessage(question, answer) {
  try {
    await axios.post(
      `${SUPABASE_URL}/rest/v1/messages`,
      {
        question,
        answer,
      },
      { headers: headers() }
    );
  } catch (err) {
    console.error("Supabase save error:", err.response?.data || err.message);
  }
}

async function handleUserMessage(message) {
  const chatId = message.chat.id;
  const text = message.text;

  const ai = await axios.post(
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
- اجعل الإجابة خاصة بالسعودية فقط
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

  const reply = ai.data.output[0].content[0].text;

  await saveMessage(text, reply);
  await sendTelegramMessage(chatId, reply);
}

app.post("/webhook", async (req, res) => {
  const message = req.body.message;

  if (!message || !message.text) {
    return res.sendStatus(200);
  }

  const uniqueId = `${message.chat.id}_${message.message_id}`;

  // إذا الرسالة تكررت، تجاهلها
  if (processedMessages.has(uniqueId)) {
    return res.sendStatus(200);
  }

  processedMessages.add(uniqueId);

  // رجّع 200 فورًا حتى Telegram لا يعيد الإرسال
  res.sendStatus(200);

  // ثم كمل المعالجة في الخلفية
  handleUserMessage(message).catch(async (err) => {
    console.error("Webhook processing error:", err.response?.data || err.message);

    try {
      await sendTelegramMessage(message.chat.id, "حدث خطأ مؤقت. حاول مرة أخرى بعد قليل.");
    } catch (telegramErr) {
      console.error("Telegram send error:", telegramErr.response?.data || telegramErr.message);
    }
  });

  // تنظيف الذاكرة بعد 10 دقائق
  setTimeout(() => {
    processedMessages.delete(uniqueId);
  }, 10 * 60 * 1000);
});

app.get("/", (req, res) => {
  res.send("Bot is running 🚀");
});

app.listen(10000, () => {
  console.log("Running on port 10000");
});

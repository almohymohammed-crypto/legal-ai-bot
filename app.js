const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// منع التكرار
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

async function upsertUser(telegramId, name) {
  await axios.post(
    `${SUPABASE_URL}/rest/v1/users`,
    {
      telegram_id: telegramId,
      name,
    },
    {
      headers: {
        ...headers(),
        Prefer: "resolution=merge-duplicates",
      },
    }
  );

  const result = await axios.get(
    `${SUPABASE_URL}/rest/v1/users?telegram_id=eq.${encodeURIComponent(
      telegramId
    )}&select=*`,
    { headers: headers() }
  );

  return result.data[0];
}

async function ensureSubscription(userId) {
  const result = await axios.get(
    `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&select=*`,
    { headers: headers() }
  );

  if (result.data.length > 0) {
    return result.data[0];
  }

  await axios.post(
    `${SUPABASE_URL}/rest/v1/subscriptions`,
    {
      user_id: userId,
      plan: "free",
      messages_limit: 10,
      messages_used: 0,
    },
    { headers: headers() }
  );

  const created = await axios.get(
    `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&select=*`,
    { headers: headers() }
  );

  return created.data[0];
}

async function incrementMessagesUsed(subscriptionId, currentUsed) {
  await axios.patch(
    `${SUPABASE_URL}/rest/v1/subscriptions?id=eq.${subscriptionId}`,
    {
      messages_used: currentUsed + 1,
    },
    { headers: headers() }
  );
}

async function saveMessage(userId, question, answer) {
  try {
    await axios.post(
      `${SUPABASE_URL}/rest/v1/messages`,
      {
        user_id: userId,
        question,
        answer,
      },
      { headers: headers() }
    );
  } catch (err) {
    console.error("Supabase save error:", err.response?.data || err.message);
  }
}

async function getOpenAIReply(text) {
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

  return ai.data.output[0].content[0].text;
}

function getLimitReachedMessage() {
  return `🚫 انتهى الحد المجاني لديك (10 رسائل).

للاستمرار، اشترك في الباقة المدفوعة.
سيتم قريبًا توفير رابط الاشتراك داخل البوت.`;
}

async function handleUserMessage(message) {
  const chatId = message.chat.id;
  const text = message.text;
  const telegramId = String(message.from.id);
  const name =
    [message.from.first_name, message.from.last_name]
      .filter(Boolean)
      .join(" ")
      .trim() || "Unknown";

  // أوامر بسيطة
  if (text === "/start") {
    await sendTelegramMessage(
      chatId,
      "أهلًا بك في المستشار القانوني 🇸🇦\n\nلك 10 رسائل مجانية. اكتب سؤالك مباشرة."
    );
    return;
  }

  if (text === "/plan") {
    const user = await upsertUser(telegramId, name);
    const subscription = await ensureSubscription(user.id);
    const used = subscription.messages_used || 0;
    const limit = subscription.messages_limit || 10;

    await sendTelegramMessage(
      chatId,
      `خطتك الحالية: ${subscription.plan}\nاستهلاكك: ${used}/${limit}`
    );
    return;
  }

  const user = await upsertUser(telegramId, name);
  const subscription = await ensureSubscription(user.id);

  const used = subscription.messages_used || 0;
  const limit = subscription.messages_limit || 10;
  const plan = subscription.plan || "free";

  if (plan === "free" && used >= limit) {
    await sendTelegramMessage(chatId, getLimitReachedMessage());
    return;
  }

  const reply = await getOpenAIReply(text);

  await saveMessage(user.id, text, reply);

  if (plan === "free") {
    await incrementMessagesUsed(subscription.id, used);
  }

  await sendTelegramMessage(chatId, reply);
}

app.post("/webhook", async (req, res) => {
  const message = req.body.message;

  if (!message || !message.text) {
    return res.sendStatus(200);
  }

  const uniqueId = `${message.chat.id}_${message.message_id}`;

  if (processedMessages.has(uniqueId)) {
    return res.sendStatus(200);
  }

  processedMessages.add(uniqueId);
  res.sendStatus(200);

  handleUserMessage(message).catch(async (err) => {
    console.error("Webhook processing error:", err.response?.data || err.message);

    try {
      await sendTelegramMessage(
        message.chat.id,
        "حدث خطأ مؤقت. حاول مرة أخرى بعد قليل."
      );
    } catch (telegramErr) {
      console.error("Telegram send error:", telegramErr.response?.data || telegramErr.message);
    }
  });

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

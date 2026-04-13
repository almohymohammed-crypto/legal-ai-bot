const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// 🔥 رابط الدفع (غيّره لاحقًا)
const PAYMENT_URL = "https://your-payment-link.com";

// منع التكرار
const processedMessages = new Set();

// إرسال رسالة عادية
async function sendTelegramMessage(chatId, text) {
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    chat_id: chatId,
    text,
  });
}

// إرسال رسالة الاشتراك
async function sendUpgradeMessage(chatId) {
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    chat_id: chatId,
    text: `🚫 انتهى الحد المجاني لديك

اشترك الآن للحصول على استخدام غير محدود 🚀`,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "اشترك الآن 💳",
            url: PAYMENT_URL,
          },
        ],
      ],
    },
  });
}

// Headers Supabase
function headers() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
  };
}

// إنشاء أو تحديث المستخدم
async function upsertUser(telegramId, name) {
  await axios.post(
    `${SUPABASE_URL}/rest/v1/users?on_conflict=telegram_id`,
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
    `${SUPABASE_URL}/rest/v1/users?telegram_id=eq.${telegramId}&select=*`,
    { headers: headers() }
  );

  return result.data[0];
}

// إنشاء الاشتراك إذا غير موجود
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

// زيادة عدد الرسائل
async function incrementMessagesUsed(subscriptionId, currentUsed) {
  await axios.patch(
    `${SUPABASE_URL}/rest/v1/subscriptions?id=eq.${subscriptionId}`,
    {
      messages_used: currentUsed + 1,
    },
    { headers: headers() }
  );
}

// حفظ الرسالة
async function saveMessage(userId, question, answer) {
  await axios.post(
    `${SUPABASE_URL}/rest/v1/messages`,
    {
      user_id: userId,
      question,
      answer,
    },
    { headers: headers() }
  );
}

// OpenAI
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

// المعالجة الرئيسية
async function handleUserMessage(message) {
  const chatId = message.chat.id;
  const text = message.text;
  const telegramId = String(message.from.id);
  const name =
    [message.from.first_name, message.from.last_name]
      .filter(Boolean)
      .join(" ")
      .trim() || "Unknown";

  // أوامر
  if (text === "/start") {
    await sendTelegramMessage(
      chatId,
      "أهلًا بك في المستشار القانوني 🇸🇦\n\nلك 10 رسائل مجانية."
    );
    return;
  }

  if (text === "/plan") {
    const user = await upsertUser(telegramId, name);
    const sub = await ensureSubscription(user.id);

    await sendTelegramMessage(
      chatId,
      `الخطة: ${sub.plan}\nاستخدمت: ${sub.messages_used}/${sub.messages_limit}`
    );
    return;
  }

  const user = await upsertUser(telegramId, name);
  const subscription = await ensureSubscription(user.id);

  const used = subscription.messages_used || 0;
  const limit = subscription.messages_limit || 10;

  if (subscription.plan === "free" && used >= limit) {
    await sendUpgradeMessage(chatId);
    return;
  }

  const reply = await getOpenAIReply(text);

  await saveMessage(user.id, text, reply);
  await incrementMessagesUsed(subscription.id, used);

  await sendTelegramMessage(chatId, reply);
}

// webhook
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
    console.error(err.response?.data || err.message);

    await sendTelegramMessage(
      message.chat.id,
      "حدث خطأ مؤقت. حاول لاحقًا"
    );
  });

  setTimeout(() => {
    processedMessages.delete(uniqueId);
  }, 10 * 60 * 1000);
});

// تشغيل السيرفر
app.listen(10000, () => {
  console.log("Running 🚀");
});

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

async function sendTelegramMessage(chatId, text) {
  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    {
      chat_id: chatId,
      text,
    }
  );
}

function supabaseHeaders() {
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
        ...supabaseHeaders(),
        Prefer: "resolution=merge-duplicates",
      },
    }
  );

  const userRes = await axios.get(
    `${SUPABASE_URL}/rest/v1/users?telegram_id=eq.${encodeURIComponent(
      telegramId
    )}&select=id,telegram_id,name`,
    {
      headers: supabaseHeaders(),
    }
  );

  return userRes.data[0];
}

async function ensureSubscription(userId) {
  const subRes = await axios.get(
    `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&select=*`,
    {
      headers: supabaseHeaders(),
    }
  );

  if (subRes.data.length > 0) {
    return subRes.data[0];
  }

  await axios.post(
    `${SUPABASE_URL}/rest/v1/subscriptions`,
    {
      user_id: userId,
      plan: "free",
      messages_limit: 10,
      messages_used: 0,
    },
    {
      headers: supabaseHeaders(),
    }
  );

  const newSubRes = await axios.get(
    `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&select=*`,
    {
      headers: supabaseHeaders(),
    }
  );

  return newSubRes.data[0];
}

async function saveMessage(userId, question, answer) {
  await axios.post(
    `${SUPABASE_URL}/rest/v1/messages`,
    {
      user_id: userId,
      question,
      answer,
    },
    {
      headers: supabaseHeaders(),
    }
  );
}

async function incrementMessagesUsed(subscriptionId, currentUsed) {
  await axios.patch(
    `${SUPABASE_URL}/rest/v1/subscriptions?id=eq.${subscriptionId}`,
    {
      messages_used: currentUsed + 1,
    },
    {
      headers: supabaseHeaders(),
    }
  );
}

async function getOpenAIReply(text) {
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
- اجعل الجواب مناسبًا للسعودية فقط
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

  return openaiResponse.data.output[0].content[0].text;
}

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
    const user = await upsertUser(telegramId, name);

    if (!user || !user.id) {
      console.error("User was not created or fetched correctly");
      return res.sendStatus(500);
    }

    const subscription = await ensureSubscription(user.id);

    if (
      subscription &&
      subscription.plan === "free" &&
      subscription.messages_used >= subscription.messages_limit
    ) {
      await sendTelegramMessage(
        chatId,
        "🚫 انتهى الحد المجاني لديك. الرجاء الاشتراك للاستمرار."
      );
      return res.sendStatus(200);
    }

    const reply = await getOpenAIReply(text);

    await saveMessage(user.id, text, reply);

    if (subscription) {
      await incrementMessagesUsed(
        subscription.id,
        subscription.messages_used || 0
      );
    }

    await sendTelegramMessage(chatId, reply);

    return res.sendStatus(200);
  } catch (error) {
    console.error(
      "Webhook error:",
      error.response ? error.response.data : error.message
    );

    try {
      await sendTelegramMessage(
        chatId,
        "حدث خطأ مؤقت. حاول مرة أخرى بعد قليل."
      );
    } catch (telegramError) {
      console.error(
        "Telegram send error:",
        telegramError.response
          ? telegramError.response.data
          : telegramError.message
      );
    }

    return res.sendStatus(500);
  }
});

app.get("/", (req, res) => {
  res.send("Bot is running 🚀");
});

app.listen(10000, () => {
  console.log("Server running on port 10000");
});

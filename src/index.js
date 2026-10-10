
const CHANNELS = [
  { name: "ХК «Молот»", username: "hcmolotperm" },
  { name: "БК «ПАРМА»", username: "parmabasketprm" },
  { name: "ФК «Амкар Пермь»", username: "amkarprm" }
];

const PREFIX = "telegram-source:";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return Response.json({
        status: "ok",
        project: "Спортивный край",
        message: "Worker работает!"
      });
    }

    // Диагностика Cron и мониторинга. Не содержит секретов.
    if (url.pathname === "/monitor-status") {
      if (!env.NEWS_KV) {
        return Response.json({
          ok: false,
          error: "NEWS_KV binding is missing"
        }, { status: 500 });
      }

      const status = await env.NEWS_KV.get("monitor:status", "json");

      return Response.json({
        ok: true,
        cron_status: status || "Cron has not recorded a run yet",
        checked_channels: CHANNELS.map(c => c.username)
      });
    }

    const tg = (method, data) => telegramApi(env, method, data);

    function authorized(req) {
      return Boolean(
        env.TELEGRAM_WEBHOOK_SECRET &&
        req.headers.get("Authorization") ===
          `Bearer ${env.TELEGRAM_WEBHOOK_SECRET}`
      );
    }

    if (url.pathname === "/setup" && request.method === "POST") {
      if (!authorized(request)) {
        return new Response("Unauthorized", { status: 401 });
      }

      return Response.json(await tg("setWebhook", {
        url: `${url.origin}/telegram`,
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: [
          "message",
          "channel_post",
          "callback_query"
        ]
      }));
    }

    if (url.pathname === "/test-post" && request.method === "POST") {
      if (!authorized(request)) {
        return new Response("Unauthorized", { status: 401 });
      }

      return Response.json(await tg("sendMessage", {
        chat_id: "@sportkrai",
        text: "🏆 Спортивный край — тестовая публикация."
      }));
    }

    if (url.pathname !== "/telegram" || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
      console.error("Webhook configuration incomplete");
      return new Response("Configuration error", { status: 500 });
    }

    if (
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") !==
      env.TELEGRAM_WEBHOOK_SECRET
    ) {
      return new Response("Unauthorized", { status: 401 });
    }

    const update = await request.json();

    if (update.callback_query) {
      const cb = update.callback_query;
      const msg = cb.message;
      const userId = String(cb.from?.id || "");
      const isAdmin =
        userId === String(env.TELEGRAM_ADMIN_ID || "") &&
        msg?.chat?.type === "private" &&
        String(msg.chat.id) === userId;

      if (!isAdmin) {
        await tg("answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "Нет доступа к этой операции.",
          show_alert: true
        });
        return new Response("OK");
      }

      const marker = "📝 Черновик «Спортивного края»\n\n";
      const visibleText = msg.text || "";
      const draft = visibleText.startsWith(marker)
        ? visibleText.slice(marker.length).trim()
        : "";

      if (!draft) {
        await tg("answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "Не удалось найти черновик.",
          show_alert: true
        });
        return new Response("OK");
      }

      if (cb.data === "publish") {
        await tg("answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "Публикую…"
        });

        const result = await tg("sendMessage", {
          chat_id: "@sportkrai",
          text: draft
        });

        if (result.ok) {
          await tg("editMessageText", {
            chat_id: msg.chat.id,
            message_id: msg.message_id,
            text: "✅ Опубликовано в @sportkrai\n\n" + draft,
            reply_markup: { inline_keyboard: [] }
          });
        } else {
          await tg("sendMessage", {
            chat_id: msg.chat.id,
            text: "❌ Не удалось опубликовать. Проверь права бота в канале."
          });
        }

        return new Response("OK");
      }

      if (cb.data === "reject") {
        await tg("answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "Черновик отклонён."
        });

        await tg("editMessageText", {
          chat_id: msg.chat.id,
          message_id: msg.message_id,
          text: "🚫 Отклонено\n\n" + draft,
          reply_markup: { inline_keyboard: [] }
        });

        return new Response("OK");
      }

      if (cb.data === "rewrite") {
        await tg("answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "Готовлю новую версию…"
        });

        const original = (
          msg.reply_to_message?.text ||
          msg.reply_to_message?.caption ||
          draft
        ).trim();

        const source = await getSourceMaterial(original);

        if (!source) {
          await tg("sendMessage", {
            chat_id: msg.chat.id,
            text: "Не удалось получить исходный материал."
          });
          return new Response("OK");
        }

        const rewritten = await rewriteNews(source, env, true);

        if (rewritten) {
          await sendDraft(tg, msg.chat.id, rewritten);
        } else {
          await tg("sendMessage", {
            chat_id: msg.chat.id,
            text: "❌ Не удалось подготовить новую версию. Проверь OpenAI API."
          });
        }

        return new Response("OK");
      }

      await tg("answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "Неизвестная команда."
      });

      return new Response("OK");
    }

    const msg = update.message;

    if (!msg?.chat?.id || msg.chat.type !== "private") {
      return new Response("OK");
    }

    const chatId = msg.chat.id;
    const input = (msg.text || msg.caption || "").trim();

    if (input.startsWith("/start")) {
      await tg("sendMessage", {
        chat_id: chatId,
        text:
          "🏆 Спортивный край на связи!\n\n" +
          "Пришли текст новости, пересланную публикацию или ссылку. " +
          "Я подготовлю черновик, а публикация выйдет только после твоего подтверждения."
      });
      return new Response("OK");
    }

    if (
      String(chatId) !== String(env.TELEGRAM_ADMIN_ID || "") ||
      String(msg.from?.id || "") !== String(env.TELEGRAM_ADMIN_ID || "")
    ) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "Этот бот предназначен для редактора канала."
      });
      return new Response("OK");
    }

    if (!input) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "Пришли текст новости или ссылку."
      });
      return new Response("OK");
    }

    if (input.startsWith("/")) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "Пришли текст новости или ссылку."
      });
      return new Response("OK");
    }

    await tg("sendMessage", {
      chat_id: chatId,
      text: "⏳ Готовлю черновик…"
    });

    const source = await getSourceMaterial(input);

    if (!source) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "❌ Не удалось прочитать ссылку. Попробуй переслать текст публикации."
      });
      return new Response("OK");
    }

    const rewritten = await rewriteNews(source, env, false);

    if (!rewritten) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "❌ Не удалось подготовить новость. Проверь OpenAI API."
      });
      return new Response("OK");
    }

    await sendDraft(tg, chatId, rewritten, msg.message_id);
    return new Response("OK");
  },

  async scheduled(controller, env, ctx) {
    console.log("CRON_STARTED", new Date().toISOString());

    ctx.waitUntil(
      monitorChannels(env).catch(async error => {
        console.error("CRON_FATAL", String(error));

        if (env.NEWS_KV) {
          await env.NEWS_KV.put("monitor:status", JSON.stringify({
            last_run: new Date().toISOString(),
            state: "error",
            error: String(error)
          }));
        }
      })
    );
  }
};

async function monitorChannels(env) {
  const startedAt = new Date().toISOString();

  if (!env.NEWS_KV || !env.OPENAI_API_KEY ||
      !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_ADMIN_ID) {
    throw new Error("Missing NEWS_KV or required environment secrets");
  }

  const result = {
    last_run: startedAt,
    state: "running",
    channels: {}
  };

  await env.NEWS_KV.put("monitor:status", JSON.stringify(result));

  for (const channel of CHANNELS) {
    console.log("CRON_CHECK_CHANNEL", channel.username);

    try {
      result.channels[channel.username] =
        await scanChannel(channel, env);
    } catch (error) {
      console.error(
        "CRON_CHANNEL_ERROR",
        channel.username,
        String(error)
      );

      result.channels[channel.username] = {
        state: "error",
        error: String(error).slice(0, 300)
      };
    }

    result.last_run = startedAt;
    result.state = "completed";

    await env.NEWS_KV.put("monitor:status", JSON.stringify(result));
  }

  console.log("CRON_FINISHED", JSON.stringify(result));
}

async function scanChannel(channel, env) {
  const response = await fetch(
    `https://t.me/s/${channel.username}`,
    {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; SportivnyKraiBot/1.0)"
      },
      signal: AbortSignal.timeout(15000)
    }
  );

  if (!response.ok) {
    throw new Error(`Telegram HTTP ${response.status}`);
  }

  const html = await response.text();
  const posts = parseTelegramPosts(html, channel.username);

  if (!posts.length) {
    throw new Error("No posts extracted from public Telegram page");
  }

  const cursorKey = `${PREFIX}${channel.username}:latest`;
  const savedCursor = await env.NEWS_KV.get(cursorKey);
  const latestId = Math.max(...posts.map(p => p.id));

  // First run establishes a baseline; it doesn't send old posts.
  if (savedCursor === null) {
    await env.NEWS_KV.put(cursorKey, String(latestId));
    console.log("CRON_BASELINE", channel.username, latestId);

    return {
      state: "baseline",
      posts_found: posts.length,
      latest_id: latestId,
      drafts_sent: 0
    };
  }

  const previousId = Number(savedCursor) || 0;
  const newPosts = posts
    .filter(post => post.id > previousId)
    .sort((a, b) => a.id - b.id);

  let draftsSent = 0;

  // Process oldest first; limit recovery bursts.
  for (const post of newPosts.slice(0, 5)) {
    const processedKey = `${PREFIX}${channel.username}:${post.id}`;

    if (await env.NEWS_KV.get(processedKey)) continue;

    if (post.date && Date.now() - post.date > MAX_AGE_MS) {
      await env.NEWS_KV.put(processedKey, "old");
      continue;
    }

    const sourceText =
      `${channel.name}\nИсточник: ${post.url}\n\n${post.text}`;

    const draft = await createMonitoredDraft(sourceText, env);

    if (draft !== "SKIP") {
      const sent = await sendDraft(
        (method, data) => telegramApi(env, method, data),
        Number(env.TELEGRAM_ADMIN_ID),
        `${draft}\n\nИсточник: ${post.url}`
      );

      if (!sent.ok) {
        throw new Error(`Could not send draft for ${post.url}`);
      }

      draftsSent++;
    }

    await env.NEWS_KV.put(
      processedKey,
      draft === "SKIP" ? "skipped" : "sent"
    );
  }

  // Advance the cursor only after the batch has been processed.
  if (newPosts.length > 0) {
    const processedIds = newPosts
      .slice(0, 5)
      .map(p => p.id);

    const highestProcessed = Math.max(...processedIds);
    await env.NEWS_KV.put(cursorKey, String(highestProcessed));
  }

  console.log("CRON_CHANNEL_DONE", channel.username, {
    posts_found: posts.length,
    new_posts: newPosts.length,
    drafts_sent: draftsSent
  });

  return {
    state: "ok",
    posts_found: posts.length,
    new_posts: newPosts.length,
    drafts_sent: draftsSent
  };
}

function parseTelegramPosts(html, username) {
  const matches = [...html.matchAll(/data-post=["']([^/"']+)\/(\d+)["']/g)];
  const posts = [];
  const seen = new Set();

  for (const match of matches) {
    const id = Number(match[2]);
    if (!Number.isFinite(id) || seen.has(id)) continue;
    seen.add(id);

    const position = match.index;
    const start = html.lastIndexOf(
      '<div class="tgme_widget_message_wrap',
      position
    );
    const next = html.indexOf(
      '<div class="tgme_widget_message_wrap',
      position + match[0].length
    );

    const block = html.slice(
      Math.max(0, start),
      next === -1 ? html.length : next
    );

    const textMatch = block.match(
      /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i
    );

    let text = textMatch ? htmlToText(textMatch[1]) : "";

    const timeMatch = block.match(
      /<time[^>]+datetime=["']([^"']+)["']/i
    );

    const date = timeMatch ? Date.parse(timeMatch[1]) : null;

    if (text) {
      posts.push({
        id,
        text: text.slice(0, 7000),
        date: Number.isFinite(date) ? date : null,
        url: `https://t.me/${username}/${id}`
      });
    }
  }

  return posts;
}

async function telegramApi(env, method, data) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    }
  );

  const result = await response.json();

  if (!result.ok) {
    console.error("Telegram API error:", method, result);
  }

  return result;
}

async function sendDraft(telegram, chatId, text, replyToMessageId) {
  const data = {
    chat_id: chatId,
    text: "📝 Черновик «Спортивного края»\n\n" + text,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Опубликовать", callback_data: "publish" },
          { text: "🔄 Переделать", callback_data: "rewrite" }
        ],
        [
          { text: "❌ Отклонить", callback_data: "reject" }
        ]
      ]
    }
  };

  if (replyToMessageId) {
    data.reply_to_message_id = replyToMessageId;
  }

  return telegram("sendMessage", data);
}

async function createMonitoredDraft(sourceText, env) {
  const systemPrompt = `Ты — редактор Telegram-канала «Спортивный край» о спорте Пермского края.

Пропускай обычную рекламу, розыгрыши, дубли и малозначительные публикации.
Рассматривай результаты, трансферы, кадровые решения, важные анонсы матчей, рекорды и интересные спортивные истории.

Если материал не подходит, ответь ровно SKIP.
Если подходит, подготовь короткую публикацию на русском языке — обычно 1–3 предложения. Стиль взрослый, живой, конкретный, без канцелярита и мотивационных клише.
Не выдумывай факты и статистику. Используй только исходный материал. Верни только текст публикации или SKIP.`;

  const response = await fetch(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.5,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: sourceText }
        ]
      })
    }
  );

  if (!response.ok) {
    throw new Error(`OpenAI HTTP ${response.status}`);
  }

  const result = await response.json();
  const content = result.choices?.[0]?.message?.content;

  if (!content || typeof content !== "string") {
    throw new Error("OpenAI returned empty content");
  }

  const cleaned = content.trim();
  return cleaned.toUpperCase() === "SKIP"
    ? "SKIP"
    : cleaned.slice(0, 3000);
}

async function getSourceMaterial(input) {
  const match = input.match(/https?:\/\/[^\s<>]+/i);
  if (!match) return input;

  const rawUrl = match[0].replace(/[),.!?]+$/, "");
  let url;

  try {
    url = new URL(rawUrl);
  } catch {
    return input;
  }

  if (!["http:", "https:"].includes(url.protocol)) return input;

  const host = url.hostname.toLowerCase();
  let fetchUrl = url.href;

  if (
    ["t.me", "www.t.me", "telegram.me"].includes(host) &&
    !url.pathname.startsWith("/s/")
  ) {
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts.length >= 2 && /^\d+$/.test(parts[1])) {
      fetchUrl = `https://t.me/s/${parts[0]}/${parts[1]}`;
    }
  }

  try {
    const response = await fetch(fetchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; SportivnyKraiBot/1.0)"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      return input.length > rawUrl.length ? input : null;
    }

    const html = await response.text();
    let extracted = "";

    if (["t.me", "www.t.me", "telegram.me"].includes(host)) {
      const post = html.match(
        /class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i
      );
      if (post) extracted = htmlToText(post[1]);
    }

    if (!extracted) {
      extracted =
        getMeta(html, "og:description") ||
        getMeta(html, "description") ||
        getTitle(html);
    }

    if (!extracted) {
      return input.length > rawUrl.length ? input : null;
    }

    const accompanyingText = input.replace(rawUrl, "").trim();

    return (
      (accompanyingText ? accompanyingText + "\n\n" : "") +
      "Материал по ссылке:\n" +
      extracted.slice(0, 9000)
    );
  } catch (error) {
    console.error("Source fetch failed:", String(error));
    return input.length > rawUrl.length ? input : null;
  }
}

function getMeta(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`,
      "i"
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`,
      "i"
    )
  ];

  for (const pattern of patterns) {
    const result = html.match(pattern);
    if (result) return htmlToText(result[1]);
  }

  return "";
}

function getTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? htmlToText(match[1]) : "";
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n/g, "\n\n")
    .trim();
}

async function rewriteNews(sourceText, env, isRewrite = false) {
  const systemPrompt = `Ты — выпускающий редактор Telegram-канала «Спортивный край» о спорте Пермского края.
Пиши естественно, конкретно и по-русски. Без канцелярита, пафоса и мотивационных клише.
Не выдумывай факты, результаты, статистику, даты, имена и цитаты.
Обычно достаточно 1–3 коротких предложений. Верни только готовую публикацию.
${isRewrite
  ? "Создай альтернативную версию, изменив структуру и формулировки, сохранив факты."
  : "Подготовь публикацию по исходному материалу, сохранив факты и смысл."}`;

  try {
    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: isRewrite ? 0.8 : 0.5,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: "Исходный материал:\n\n" + sourceText }
          ]
        })
      }
    );

    if (!response.ok) {
      console.error("OpenAI API error:", response.status, await response.text());
      return null;
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;

    return typeof content === "string" && content.trim()
      ? content.trim().slice(0, 3900)
      : null;
  } catch (error) {
    console.error("OpenAI request failed:", String(error));
    return null;
  }
}

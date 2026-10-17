
const CHANNELS = [
  { name: "ХК «Молот»", username: "hcmolotperm" },
  { name: "БК «ПАРМА»", username: "parmabasketprm" },
  { name: "ФК «Амкар Пермь»", username: "amkarprm" },
  {
    name: "ГК «Пермские медведи»",
    username: "permmedvedi",
    type: "handball"
  }
];


const STANDINGS_SOURCES = [
  { name: "ХК «Молот»", url: "https://vhlru.ru/calendar/", team: "Молот" },
  { name: "БК «ПАРМА»", url: "https://vtb-league.com/ru/rbwidget/standings/?compId=55613", team: "ПАРМА" },
  { name: "ФК «Амкар Пермь»", url: "https://www.sport-express.ru/football/n/russia/d2/silver/2026-2027/table/", team: "Амкар" },
  { name: "ГК «Пермские медведи»", url: "https://rushandball.ru/competitions/12179/", team: "Пермские медведи" }
];

const PREFIX = "telegram-source:";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TARGET_CHANNEL = "@sportkrai";
const DRAFT_MARKER = "📝 Черновик «Спортивного края»\n\n";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const tg = (method, data) => telegramApi(env, method, data);

    if (url.pathname === "/") {
      return Response.json({
        status: "ok",
        project: "Спортивный край",
        message: "Worker работает!"
      });
    }

    if (url.pathname === "/monitor-status") {
      if (!env.NEWS_KV) {
        return Response.json(
          { ok: false, error: "NEWS_KV binding is missing" },
          { status: 500 }
        );
      }

      return Response.json({
        ok: true,
        cron_status: await env.NEWS_KV.get("monitor:status", "json"),
        checked_channels: CHANNELS.map(c => c.username)
      });
    }

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
        allowed_updates: ["message", "channel_post", "callback_query"]
      }));
    }

    if (url.pathname === "/test-post" && request.method === "POST") {
      if (!authorized(request)) {
        return new Response("Unauthorized", { status: 401 });
      }

      return Response.json(await tg("sendMessage", {
        chat_id: TARGET_CHANNEL,
        text: "🏆 Спортивный край — тестовая публикация."
      }));
    }

    if (url.pathname !== "/telegram" || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
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

      const visibleText = msg.caption || msg.text || "";
      const draft = visibleText.startsWith(DRAFT_MARKER)
        ? visibleText.slice(DRAFT_MARKER.length).trim()
        : "";

      if (!draft) {
        await tg("answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "Не удалось найти текст черновика.",
          show_alert: true
        });
        return new Response("OK");
      }

      if (cb.data === "publish") {
        await tg("answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "Публикую…"
        });

        const photo = Array.isArray(msg.photo) && msg.photo.length
          ? msg.photo[msg.photo.length - 1].file_id
          : null;

        const publication = `${draft}\n\n🤖 Автоматическая новость`;

        const result = photo
          ? await tg("sendPhoto", {
              chat_id: TARGET_CHANNEL,
              photo,
              caption: publication.slice(0, 1024)
            })
          : await tg("sendMessage", {
              chat_id: TARGET_CHANNEL,
              text: publication.slice(0, 4000)
            });

        if (result.ok) {
          await markDraftMessage(
            tg, msg,
            `✅ Опубликовано в ${TARGET_CHANNEL}\n\n${draft}`
          );
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

        await markDraftMessage(tg, msg, `🚫 Отклонено\n\n${draft}`);
        return new Response("OK");
      }

      if (cb.data === "rewrite") {
        await tg("answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "Готовлю новую версию…"
        });

        const rewritten = await rewriteNews(draft, env, true);

        if (rewritten) {
          await sendDraft(tg, msg.chat.id, rewritten, undefined, env);
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
          "Я подготовлю редакционный текст и картинку. " +
          "Ручные публикации отправляются после твоего подтверждения."
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

    if (!input || input.startsWith("/")) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "Пришли текст новости, пересланную публикацию или ссылку."
      });
      return new Response("OK");
    }

    await tg("sendMessage", {
      chat_id: chatId,
      text: "⏳ Редактирую новость и готовлю изображение…"
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

    await sendDraft(tg, chatId, rewritten, msg.message_id, env);
    return new Response("OK");
  },

  async scheduled(controller, env, ctx) {
    const cron = controller.cron || "*/15 * * * *";
    console.log("CRON_STARTED", cron, new Date().toISOString());

    ctx.waitUntil((async () => {
      try {
        if (cron === "0 13 * * 4") {
          await publishWeeklyCalendar(env);
          return;
        }
        if (cron === "0 4 * * 1") {
          await publishWeekendRecap(env);
          return;
        }
        if (cron === "0 13 * * 2") {
          await publishStandings(env);
          return;
        }
        await monitorChannels(env);
      } catch (error) {
        console.error("CRON_FATAL", cron, String(error));
        if (env.NEWS_KV) {
          await env.NEWS_KV.put("monitor:status", JSON.stringify({
            last_run: new Date().toISOString(),
            cron,
            state: "error",
            error: String(error).slice(0, 500)
          }));
        }
      }
    })());
  }
};

// ============================================================
// ЕЖЕНЕДЕЛЬНЫЙ КАЛЕНДАРЬ И ИТОГИ ВЫХОДНЫХ
// ============================================================

async function readRecentClubPosts(channel, env) {
  const response = await fetch(`https://t.me/s/${channel.username}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; SportivnyKraiBot/1.0)"
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    throw new Error(`Telegram HTTP ${response.status} for ${channel.username}`);
  }
  const html = await response.text();
  return parseTelegramPosts(html, channel.username)
    .sort((a, b) => b.id - a.id)
    .slice(0, 12)
    .map(post => ({
      club: channel.name,
      url: post.url,
      date: post.date ? new Date(post.date).toISOString() : null,
      text: post.text.slice(0, 2500)
    }));
}

function localDateISO(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Yekaterinburg",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const part = name => parts.find(item => item.type === name)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

async function generateScheduledCopy(kind, posts, env) {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is missing");
  const today = localDateISO();
  const isCalendar = kind === "calendar";
  const system = isCalendar
    ? `Ты выпускающий редактор Telegram-канала «Спортивный край». Составь календарь матчей четырёх пермских команд на ближайшие 7 дней, начиная с ${today}: ХК «Молот», БК «ПАРМА», ФК «Амкар Пермь», ГК «Пермские медведи». Используй ТОЛЬКО подтверждённые в источниках предстоящие матчи. Не включай прошедшие матчи, тренировочные новости, слухи и неуказанные даты/время. Если время не указано, напиши «время не указано». Сгруппируй по дням, внутри дня — по клубам. У каждого матча укажи клуб, соперника, турнир (если есть), дату и время (только если указаны), ссылку на источник. Заголовок: «📅 Матчи пермских команд: ближайшая неделя». Внизу ровно два хэштега: #СпортивныйКрай #СпортПрикамья. Если подтверждённых матчей нет, верни ровно NO_CONFIRMED_MATCHES. Не додумывай и не прогнозируй.`
    : `Ты выпускающий редактор Telegram-канала «Спортивный край». Подведи итоги прошедших выходных (суббота и воскресенье) для ХК «Молот», БК «ПАРМА», ФК «Амкар Пермь» и ГК «Пермские медведи». Используй только факты из источников: финальные результаты и счёт, если они прямо указаны. Не выдавай анонсы за результаты, не придумывай счёт, авторов голов, статистику и турнирное положение. Объедини подтверждённые результаты в одну компактную публикацию с заголовком «🏆 Итоги выходных в спорте Прикамья». У каждого результата укажи клуб, соперника и счёт только если они подтверждены, добавь ссылку на источник. Внизу ровно два хэштега: #СпортивныйКрай #СпортПрикамья. Если нет подтверждённых результатов за выходные, верни ровно NO_CONFIRMED_RESULTS.`;
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: JSON.stringify({ date_in_perm: today, sources: posts })
        }
      ]
    })
  });
  if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}`);
  const result = await response.json();
  const text = result.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("OpenAI returned empty scheduled post");
  return text;
}

async function publishScheduledPost(kind, env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.NEWS_KV) {
    throw new Error("Missing Telegram token or NEWS_KV");
  }
  const key = `scheduled-post:${kind}:${localDateISO()}`;
  if (await env.NEWS_KV.get(key)) {
    console.log("SCHEDULED_POST_ALREADY_HANDLED", kind, localDateISO());
    return;
  }

  const posts = [];
  const failures = [];
  for (const channel of CHANNELS) {
    try {
      const sourcePosts = await readRecentClubPosts(channel, env);
      if (!sourcePosts.length) {
        throw new Error("No posts extracted from source");
      }
      posts.push(...sourcePosts);
    } catch (error) {
      failures.push(`${channel.username}: ${String(error)}`);
      console.error("SCHEDULED_SOURCE_ERROR", channel.username, String(error));
    }
  }
  if (failures.length) {
    // Не публикуем сводку по неполному набору команд: это может создать
    // ложное впечатление, что расписание или итоги проверены полностью.
    throw new Error(`Scheduled ${kind} aborted: incomplete sources: ${failures.join("; ")}`);
  }
  if (posts.length < CHANNELS.length) {
    throw new Error(`Scheduled ${kind} aborted: expected posts from all ${CHANNELS.length} sources`);
  }

  const text = await generateScheduledCopy(kind, posts, env);
  const skipTokens = kind === "calendar"
    ? ["NO_CONFIRMED_MATCHES"]
    : ["NO_CONFIRMED_RESULTS"];
  if (skipTokens.includes(text.trim())) {
    await env.NEWS_KV.put(key, "no-confirmed-content");
    console.log("SCHEDULED_POST_SKIPPED", kind, "No confirmed content");
    return;
  }

  // Не разрешаем модели добавлять ссылки, которых не было в источниках.
  const sourceUrls = new Set(posts.map(post => post.url));
  const outputUrls = text.match(/https?:\/\/[^\s)\]>]+/g) || [];
  const unverifiedUrls = outputUrls.filter(url => !sourceUrls.has(url.replace(/[.,!?]+$/, "")));
  if (unverifiedUrls.length) {
    throw new Error(`Scheduled ${kind} rejected: unverified links: ${unverifiedUrls.join(", ")}`);
  }

  const telegramResponse = await telegramApi(env, "sendMessage", {
    chat_id: TARGET_CHANNEL,
    text: `${text.slice(0, 3600)}\n\n🤖 Автоматическая публикация`,
    disable_web_page_preview: true
  });
  if (!telegramResponse?.ok) {
    throw new Error(`Telegram publish failed for ${kind}`);
  }
  await env.NEWS_KV.put(key, JSON.stringify({
    status: "published",
    date: localDateISO(),
    message_id: telegramResponse.result?.message_id || null,
    source_failures: failures
  }));
  console.log("SCHEDULED_POST_PUBLISHED", kind, localDateISO());
}

async function publishWeeklyCalendar(env) {
  return publishScheduledPost("calendar", env);
}

async function publishWeekendRecap(env) {
  return publishScheduledPost("recap", env);
}

async function fetchStandingsSource(source) {
  const response = await fetch(source.url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; SportivnyKraiBot/1.0)" },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error("HTTP " + response.status);
  const html = await response.text();
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(?:br|\/tr|\/td|\/th|\/li|\/p|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '" '.trim())
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&mdash;|&ndash;/gi, "-")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length < 250) throw new Error("Page has too little readable content");
  return { name: source.name, url: source.url, team: source.team, text: cleaned.slice(0, 14000) };
}

async function publishStandings(env) {
  if (!env.NEWS_KV || !env.OPENAI_API_KEY || !env.TELEGRAM_BOT_TOKEN) throw new Error("Missing required environment binding");
  const date = localDateISO();
  const key = "scheduled-post:standings:" + date;
  if (await env.NEWS_KV.get(key)) return;
  const sources = [];
  const failures = [];
  for (const source of STANDINGS_SOURCES) {
    try { sources.push(await fetchStandingsSource(source)); }
    catch (error) { failures.push(source.team + ": " + String(error)); console.error("STANDINGS_SOURCE_ERROR", source.team, String(error)); }
  }
  if (sources.length !== STANDINGS_SOURCES.length) throw new Error("Standings post aborted; incomplete source set: " + failures.join("; "));
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.OPENAI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini", temperature: 0,
      messages: [
        { role: "system", content: "Ты редактор спортивного Telegram-канала «Спортивный край». Подготовь компактную публикацию «📊 Положение пермских команд». Для каждой команды укажи место и очки только если они прямо присутствуют в переданном тексте и однозначно относятся к нужной команде: ХК «Молот» (ВХЛ), БК «ПАРМА» (Единая лига ВТБ), ФК «Амкар Пермь» (вторая лига А, группа «Серебро»), ГК «Пермские медведи» (мужская Суперлига). Если нужная таблица или команда не читается, напиши «данные не удалось подтвердить». Не смешивай сезоны и турниры. Укажи URL источника из поля url. Не выдумывай данные или ссылки. Внизу ровно два хэштега: #СпортивныйКрай #СпортПрикамья. Верни только текст публикации." },
        { role: "user", content: JSON.stringify({ date: date, sources: sources }) }
      ]
    })
  });
  if (!response.ok) throw new Error("OpenAI standings HTTP " + response.status);
  const result = await response.json();
  const post = result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content ? result.choices[0].message.content.trim() : "";
  if (!post) throw new Error("Empty standings response");
  const sent = await telegramApi(env, "sendMessage", { chat_id: TARGET_CHANNEL, text: post.slice(0, 3600) + "\n\n🤖 Автоматическая публикация", disable_web_page_preview: true });
  if (!sent || !sent.ok) throw new Error("Telegram failed to publish standings");
  await env.NEWS_KV.put(key, JSON.stringify({ status: "published", date: date, message_id: sent.result && sent.result.message_id || null }));
  console.log("STANDINGS_POST_PUBLISHED", date);
}

// ============================================================
// МОНИТОРИНГ ИСТОЧНИКОВ
// ============================================================

async function monitorChannels(env) {
  const startedAt = new Date().toISOString();

  if (
    !env.NEWS_KV ||
    !env.OPENAI_API_KEY ||
    !env.TELEGRAM_BOT_TOKEN ||
    !env.TELEGRAM_ADMIN_ID
  ) {
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
      result.channels[channel.username] = await scanChannel(channel, env);
    } catch (error) {
      console.error("CRON_CHANNEL_ERROR", channel.username, String(error));
      result.channels[channel.username] = {
        state: "error",
        error: String(error).slice(0, 300)
      };
    }

    result.last_run = startedAt;
    result.state = Object.values(result.channels).some(
      channelResult => channelResult?.state === "error"
    ) ? "completed_with_errors" : "completed";
    await env.NEWS_KV.put("monitor:status", JSON.stringify(result));
  }

  console.log("CRON_FINISHED", JSON.stringify(result));
}

async function scanChannel(channel, env) {
  const response = await fetch(`https://t.me/s/${channel.username}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; SportivnyKraiBot/1.0)"
    },
    signal: AbortSignal.timeout(15000)
  });

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
  const latestId = Math.max(...posts.map(post => post.id));

  if (savedCursor === null) {
    await env.NEWS_KV.put(cursorKey, String(latestId));
    console.log("CRON_BASELINE", channel.username, latestId);

    return {
      state: "baseline",
      posts_found: posts.length,
      latest_id: latestId,
      published: 0
    };
  }

  const previousId = Number(savedCursor) || 0;
  const newPosts = posts
    .filter(post => post.id > previousId)
    .sort((a, b) => a.id - b.id);

  let published = 0;
  let highestProcessed = previousId;

  for (const post of newPosts.slice(0, 5)) {
    const processedKey = `${PREFIX}${channel.username}:${post.id}`;

    if (await env.NEWS_KV.get(processedKey)) {
      highestProcessed = Math.max(highestProcessed, post.id);
      continue;
    }

    if (post.date && Date.now() - post.date > MAX_AGE_MS) {
      await env.NEWS_KV.put(processedKey, "old");
      highestProcessed = Math.max(highestProcessed, post.id);
      continue;
    }

    const sourceText =
      `${channel.name}\nИсточник: ${post.url}\n\n${post.text}`;

    const draft = await createMonitoredDraft(sourceText, env, channel);

    if (draft === "SKIP") {
      await env.NEWS_KV.put(processedKey, "skipped");
      highestProcessed = Math.max(highestProcessed, post.id);
      continue;
    }

    const publication =
      `${draft}\n\nИсточник: ${post.url}\n\n🤖 Автоматическая новость`;

    const bannerUrl = getClubBannerUrl(`${channel.name}\n${sourceText}`);
    const telegram = (method, data) => telegramApi(env, method, data);

    let sent = await telegram("sendPhoto", {
      chat_id: TARGET_CHANNEL,
      photo: bannerUrl,
      caption: publication.slice(0, 1024)
    });

    if (!sent?.ok) {
      console.error("Photo publication failed:", sent);

      sent = await telegram("sendMessage", {
        chat_id: TARGET_CHANNEL,
        text: publication.slice(0, 4000)
      });
    }

    if (!sent?.ok) {
      throw new Error(`Could not publish ${post.url}`);
    }

    published++;
    await env.NEWS_KV.put(processedKey, "published");
    highestProcessed = Math.max(highestProcessed, post.id);
  }

  if (highestProcessed > previousId) {
    await env.NEWS_KV.put(cursorKey, String(highestProcessed));
  }

  console.log("CRON_CHANNEL_DONE", channel.username, {
    posts_found: posts.length,
    new_posts: newPosts.length,
    published
  });

  return {
    state: "ok",
    posts_found: posts.length,
    new_posts: newPosts.length,
    published
  };
}

// ============================================================
// ПАРСИНГ TELEGRAM
// ============================================================

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

    const text = textMatch ? htmlToText(textMatch[1]) : "";
    const timeMatch = block.match(/<time[^>]+datetime=["']([^"']+)["']/i);
    const date = timeMatch ? Date.parse(timeMatch[1]) : null;

    if (text) {
      posts.push({
        id,
        text: text.slice(0, 7000),
        date: Number.isFinite(date) ? date : null,
        url: `https://t.me/${username}/${id}`,
        imageUrl: extractTelegramImage(block)
      });
    }
  }

  return posts;
}

function extractTelegramImage(block) {
  const patterns = [
    /<a[^>]+style=["'][^"']*background-image:\s*url\(['"]?([^)'";]+)['"]?\)/i,
    /<img[^>]+src=["']([^"']+)["']/i
  ];

  for (const pattern of patterns) {
    const match = block.match(pattern);

    if (match?.[1] && /^https:\/\//i.test(match[1])) {
      return match[1].replace(/&amp;/g, "&");
    }
  }

  return null;
}

// ============================================================
// TELEGRAM API
// ============================================================

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

async function markDraftMessage(telegram, msg, text) {
  const isPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;

  if (isPhoto) {
    return telegram("editMessageCaption", {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      caption: text.slice(0, 1024),
      reply_markup: { inline_keyboard: [] }
    });
  }

  return telegram("editMessageText", {
    chat_id: msg.chat.id,
    message_id: msg.message_id,
    text: text.slice(0, 4000),
    reply_markup: { inline_keyboard: [] }
  });
}

// ============================================================
// РУЧНЫЕ ЧЕРНОВИКИ
// ============================================================

async function sendDraft(
  telegram,
  chatId,
  text,
  replyToMessageId,
  env,
  imageUrl
) {
  const caption = DRAFT_MARKER + text;
  const keyboard = {
    inline_keyboard: [
      [
        { text: "✅ Опубликовать", callback_data: "publish" },
        { text: "🔄 Переделать", callback_data: "rewrite" }
      ],
      [{ text: "❌ Отклонить", callback_data: "reject" }]
    ]
  };

  const bannerUrl = getClubBannerUrl(text);
  const result = await telegram("sendPhoto", {
    chat_id: chatId,
    photo: bannerUrl,
    caption: caption.slice(0, 1024),
    reply_markup: keyboard,
    ...(replyToMessageId
      ? { reply_to_message_id: replyToMessageId }
      : {})
  });

  if (result?.ok) return result;

  console.error("Could not send club banner:", result);

  return telegram("sendMessage", {
    chat_id: chatId,
    text:
      "⚠️ Не удалось отправить баннер. Проверь файлы в папке assets.\n\n" +
      text.slice(0, 3500),
    ...(replyToMessageId
      ? { reply_to_message_id: replyToMessageId }
      : {})
  });
}

// ============================================================
// ВЫБОР БАННЕРА — НОВЫЕ ИМЕНА ФАЙЛОВ
// ============================================================

function getClubBannerUrl(text) {
  const value = String(text || "").toLowerCase();
  const base =
    "https://raw.githubusercontent.com/alex1kriv-cmd/sportivny-krai-bot/main/assets/";

  if (/пермские медведи|permmedvedi|гандбол|гандболь|handball/.test(value)) {
    return base + "medvedi.png";
  }

  if (/парма|баскетбол|баскетболь|basketball/.test(value)) {
    return base + "parma.png";
  }

  if (/амкар|футбол|футболь|soccer|football/.test(value)) {
    return base + "amkar.png";
  }

  return base + "molot.png";
}

// ============================================================
// АВТОМАТИЧЕСКАЯ РЕДАКТУРА
// ============================================================

async function createMonitoredDraft(sourceText, env, channel) {
  const isHandball = channel?.type === "handball";

  const systemPrompt = `Ты — спортивный журналист и редактор Telegram-канала «Спортивный край» о спорте Пермского края.

ОТБОР
Пропускай рекламу, розыгрыши, дубли и малозначительные публикации. Для обычных источников выбирай значимые спортивные новости Пермского края.

${isHandball ? `СТРОГИЙ ФИЛЬТР ДЛЯ «ПЕРМСКИХ МЕДВЕДЕЙ»
Публикуй ТОЛЬКО анонсы предстоящих матчей и результаты сыгранных матчей гандбольной команды.
Пропускай интервью, тренировки, поздравления, сборы, рекламу, общие новости клуба и составы, если это не анонс конкретного матча.
Если из исходника нельзя уверенно определить, что это анонс матча или его результат, верни ровно SKIP.
Не выдумывай дату, время, соперника, счёт или статистику.
` : ""}

СТИЛЬ
Пиши живо, естественно и по-человечески. Начинай с главного факта. Избегай канцелярита, штампов и искусственной интриги.

СТРУКТУРА
Короткий заголовок с одним подходящим эмодзи в первой строке. Затем пустая строка и 2–3 коротких абзаца. Используй естественные переносы строк.

ТОЧНОСТЬ
Не выдумывай счёт, статистику, даты, имена, цитаты, травмы, трансферы, причины или турнирное положение.

ХЭШТЕГИ
В конце ровно два тематических хэштега.
Для «Молота»: #Молот #Хоккей
Для «ПАРМЫ»: #Парма #Баскетбол
Для «Амкара»: #АмкарПермь #Футбол
Для «Пермских медведей»: #ПермскиеМедведи #Гандбол

Верни только готовую публикацию или SKIP.`;

  const response = await fetch(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.65,
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

// ============================================================
// ПОЛУЧЕНИЕ ИСХОДНОГО МАТЕРИАЛА
// ============================================================

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

// ============================================================
// РУЧНАЯ РЕДАКТУРА НОВОСТЕЙ
// ============================================================

async function rewriteNews(sourceText, env, isRewrite = false) {
  const systemPrompt = `Ты — спортивный журналист и редактор Telegram-канала «Спортивный край».

Подготовь самостоятельную редакционную публикацию живым современным русским языком. Начинай с самого интересного подтверждённого факта.

ФОРМАТ
Короткий заголовок с одним уместным эмодзи. Пустая строка. Далее 2–3 коротких абзаца. Не превращай текст в сплошную стену.

ИЗБЕГАЙ ШТАМПОВ
Не используй канцелярит, пустой пафос, искусственную интригу и одинаковые вступления.

ФАКТЫ
Не придумывай счёт, статистику, даты, имена, цитаты, причины, последствия, травмы, трансферы или турнирное положение. Не добавляй сведений, которых нет в исходнике.

ХЭШТЕГИ
В конце добавь ровно два релевантных хэштега: команда и вид спорта.
Примеры: #Молот #Хоккей, #Парма #Баскетбол, #АмкарПермь #Футбол.
Перед хэштегами оставь пустую строку.

${isRewrite
  ? "Создай альтернативную версию с другим началом и структурой, сохранив факты."
  : "Подготовь живую и ясную публикацию, сохранив факты исходника."}

Верни только готовый текст.`;

  try {
    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: isRewrite ? 0.8 : 0.65,
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: "Исходный материал:\n\n" + sourceText
            }
          ]
        })
      }
    );

    if (!response.ok) {
      console.error(
        "OpenAI API error:",
        response.status,
        await response.text()
      );
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

// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================================

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

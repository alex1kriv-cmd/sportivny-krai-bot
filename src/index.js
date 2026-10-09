export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return Response.json({
        status: "ok",
        project: "Спортивный край"
      });
    }

    // Одноразовая настройка webhook
    if (url.pathname === "/setup" && request.method === "POST") {
      const key = request.headers.get("Authorization");

      if (
        !env.TELEGRAM_WEBHOOK_SECRET ||
        key !== `Bearer ${env.TELEGRAM_WEBHOOK_SECRET}`
      ) {
        return new Response("Unauthorized", { status: 401 });
      }

      const result = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: `${url.origin}/telegram`,
            secret_token: env.TELEGRAM_WEBHOOK_SECRET
          })
        }
      );

      return new Response(await result.text(), {
        headers: { "Content-Type": "application/json" },
        status: result.status
      });
    }

    // Приём сообщений от Telegram
    if (url.pathname === "/telegram" && request.method === "POST") {
      if (
        !env.TELEGRAM_WEBHOOK_SECRET ||
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") !==
          env.TELEGRAM_WEBHOOK_SECRET
      ) {
        return new Response("Unauthorized", { status: 401 });
      }

      const update = await request.json();
      const message = update.message;
      const chatId = message?.chat?.id;
      const text = message?.text || "";

      if (chatId && text.startsWith("/start")) {
        await fetch(
          `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text:
                "🏆 Спортивный край на связи!\n\n" +
                "Бот запущен. Скоро здесь появятся новости " +
                "пермского спорта и кнопки одобрения публикаций."
            })
          }
        );
      }

      return new Response("OK");
    }

    return new Response("Not found", { status: 404 });
  }
};

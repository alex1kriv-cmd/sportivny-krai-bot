
export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(
        JSON.stringify({
          status: "ok",
          project: "Спортивный край",
          message: "Worker работает!"
        }),
        {
          headers: {
            "content-type": "application/json; charset=utf-8"
          }
        }
      );
    }

    return new Response("Not found", { status: 404 });
  }
};

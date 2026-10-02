import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { compress } from "hono/compress";

// @ts-ignore - dependent on build being ran
import build from "./dist/index.js";

const app = new Hono();
app.use(compress());
app.use(
  serveStatic({
    root: "dist/static",
    rewriteRequestPath(path) {
      path.startsWith("/static/");
      return path.replace(/^\/static/, "");
    },
    onFound(path, c) {
      if (path.startsWith("/js/")) {
        c.header("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  }),
);
app.route("", build);

serve(
  {
    fetch: app.fetch.bind(app),
    port: 3001,
  },
  (info) => {
    console.log(`Listening at http://localhost:${info.port}`);
  },
);

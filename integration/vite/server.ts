import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { compress } from "hono/compress";

// @ts-ignore - dependent on build being ran
import build from "./dist/ssr/index.js";

const app = new Hono();
app.use(compress());
app.use(
  serveStatic({
    root: "dist/client",
    onFound(path, c) {
      if (path.startsWith("/assets/")) {
        c.header("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  }),
);
app.route("", build);

serve(app, (info) => {
  console.log(`Listening at http://localhost:${info.port}`);
});

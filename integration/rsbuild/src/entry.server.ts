import { createApp } from "@integration/base";
import { runtime } from "rsbuild-plugin-preact-progressive/server";

import assets from "./entry.client.ts?assets=client";

const app = createApp({ assets, renderer: { runtime } });

export default app;

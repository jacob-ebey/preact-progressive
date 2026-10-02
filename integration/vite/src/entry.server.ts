import { createApp } from "@integration/base";

import "./styles.css";
import clientAssets from "./entry.client.ts?assets=client";
import serverAssets from "./entry.server.ts?assets=ssr";

const assets = serverAssets.merge(clientAssets);

const app = createApp({ assets });

export default app;

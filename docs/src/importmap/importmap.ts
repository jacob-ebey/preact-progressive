import preact from "./preact.ts?assets=client";
import preactProgressiveClient from "./preact-progressive.client.ts?assets=client";

export default {
  imports: {
    preact: preact.entry,
    "preact/jsx-runtime": preact.entry,
    "preact/hooks": preact.entry,
    "preact/compat": preact.entry,
    "preact-progressive/client": preactProgressiveClient.entry,
  },
};

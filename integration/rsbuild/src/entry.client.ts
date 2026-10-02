import { prgressiveHydrate } from "preact-progressive/client";
import { loadModule } from "rsbuild-plugin-preact-progressive/client";

import "./styles.css";

prgressiveHydrate(document.documentElement, { loadModule });

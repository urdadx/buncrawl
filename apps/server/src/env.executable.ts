// Selected for `#env` by the `buncrawl-executable` build condition (see package.json "imports").
import { parsePlainEnv } from "./env.plain";

export const ENV = parsePlainEnv(process.env);

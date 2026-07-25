import { parseEnv } from "./config/env.js";

/**
 * Entry point.
 *
 * Deliberately does almost nothing yet. The channel, provider, agent-loop and memory seams
 * are still open decisions (see the wayfinder map, issue #1) and wiring them before those
 * close would mean guessing. What this proves today: the toolchain runs and config validates.
 */
const main = (): void => {
  const env = parseEnv();

  console.log(`cadence-agent starting (env=${env.NODE_ENV}, log=${env.LOG_LEVEL})`);
  console.log(`data dir: ${env.DATA_DIR}`);
  console.log("no channels wired yet — see https://github.com/seahsky/cadence-agent/issues/1");
};

main();

import { buildApp } from "./app.js";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { createGateway } from "./payments/index.js";
import { defaultProviders } from "./pricing/providers.js";
import { repriceSingles } from "./pricing/reprice.js";

const app = await buildApp({ prisma, gateway: createGateway(), logger: true });
await app.listen({ port: config.port, host: "0.0.0.0" });

// Market prices: pull the feeds on a schedule so 7-day trends have history.
// Off unless PRICE_REFRESH_HOURS is set (e.g. 24). Run one server instance with it on.
const hours = Number(process.env.PRICE_REFRESH_HOURS ?? 0);
if (hours > 0) {
  const run = () =>
    repriceSingles(prisma, defaultProviders, undefined, { trigger: "scheduled" })
      .then((r) => app.log.info(r, "market prices refreshed"))
      .catch((e) => app.log.error(e, "market price refresh failed"));
  setInterval(run, hours * 3_600_000);
  run();
}

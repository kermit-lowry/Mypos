import { buildApp } from "./app.js";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { createGateway } from "./payments/index.js";

const app = await buildApp({ prisma, gateway: createGateway(), logger: true });
await app.listen({ port: config.port, host: "0.0.0.0" });

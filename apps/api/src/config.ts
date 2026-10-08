// Load .env before reading any setting, so every process (server, scripts,
// seeds) sees the same secrets regardless of import order. Variables already
// set in the environment win.
try {
  process.loadEnvFile(".env");
} catch {
  // No .env file (production uses real environment variables).
}

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing env var ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  jwtSecret: env("JWT_SECRET", process.env.NODE_ENV === "production" ? undefined : "dev-secret"),
  /** Server secret mixed into PIN lookups. Defaults to the JWT secret. */
  pinPepper: process.env.PIN_PEPPER ?? process.env.JWT_SECRET ?? "dev-secret",
  paymentGateway: (process.env.PAYMENT_GATEWAY ?? "mock") as "mock" | "nmi" | "authorizenet",
  nmi: { securityKey: process.env.NMI_SECURITY_KEY ?? "" },
  authnet: {
    loginId: process.env.AUTHNET_API_LOGIN_ID ?? "",
    transactionKey: process.env.AUTHNET_TRANSACTION_KEY ?? "",
    sandbox: process.env.AUTHNET_SANDBOX !== "false",
  },
  currency: process.env.CURRENCY ?? "USD",
  handpoint: {
    apiKey: process.env.HANDPOINT_API_KEY ?? "",
    environment: (process.env.HANDPOINT_ENV === "production" ? "production" : "development") as "production" | "development",
  },
  pokemonTcgApiKey: process.env.POKEMONTCG_API_KEY ?? "",
  shopify: {
    shop: process.env.SHOPIFY_SHOP ?? "",
    accessToken: process.env.SHOPIFY_ACCESS_TOKEN ?? "",
    locationId: process.env.SHOPIFY_LOCATION_ID ?? "",
  },
  tcgplayer: {
    accessToken: process.env.TCGPLAYER_ACCESS_TOKEN ?? "",
    storeKey: process.env.TCGPLAYER_STORE_KEY ?? "",
  },
  ebay: { accessToken: process.env.EBAY_ACCESS_TOKEN ?? "" },
};

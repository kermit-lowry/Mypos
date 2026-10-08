import { config } from "../config.js";
import { AuthorizeNetGateway } from "./authorizenet.js";
import type { PaymentGateway } from "./gateway.js";
import { HandpointGateway } from "./handpoint.js";
import { MockGateway } from "./mock.js";
import { NmiGateway } from "./nmi.js";
import { RoutingGateway } from "./router.js";

export type { PaymentGateway } from "./gateway.js";

/** Online (card-not-present) processor for the web store and keyed entries. */
function cardNotPresent(): PaymentGateway {
  switch (config.paymentGateway) {
    case "nmi":
      return new NmiGateway(config.nmi.securityKey);
    case "authorizenet":
      return new AuthorizeNetGateway(config.authnet.loginId, config.authnet.transactionKey, config.authnet.sandbox);
    default:
      return new MockGateway();
  }
}

/** In-store (card-present) processor: Handpoint on PAX terminals. */
function cardPresent(): PaymentGateway {
  if (config.handpoint.apiKey) {
    return new HandpointGateway({ apiKey: config.handpoint.apiKey, environment: config.handpoint.environment, currency: config.currency });
  }
  return new MockGateway();
}

export function createGateway(): PaymentGateway {
  return new RoutingGateway(cardPresent(), cardNotPresent());
}

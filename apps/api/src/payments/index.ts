import { config } from "../config.js";
import { AuthorizeNetGateway } from "./authorizenet.js";
import type { PaymentGateway } from "./gateway.js";
import { MockGateway } from "./mock.js";
import { NmiGateway } from "./nmi.js";

export type { PaymentGateway } from "./gateway.js";

export function createGateway(): PaymentGateway {
  switch (config.paymentGateway) {
    case "nmi":
      return new NmiGateway(config.nmi.securityKey);
    case "authorizenet":
      return new AuthorizeNetGateway(config.authnet.loginId, config.authnet.transactionKey, config.authnet.sandbox);
    default:
      return new MockGateway();
  }
}

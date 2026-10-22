import { loadStripe } from "@stripe/stripe-js/pure/index.js";
import type {
  Appearance,
  StripeCheckoutElementsSdkOptions,
  StripeCheckoutSession,
} from "@stripe/stripe-js";

export interface ElementsCheckout {
  uiMode: "elements";
  clientSecret: string;
  publishableKey: string;
  stripeAccount?: string;
  returnUrl: string;
}
export type CheckoutSession = Pick<
  StripeCheckoutSession,
  "currency" | "status" | "canConfirm"
> & {
  total: Pick<StripeCheckoutSession["total"], "total">;
};
export interface CheckoutActions {
  getSession(): CheckoutSession;
  confirm(options: {
    returnUrl: string;
    redirect: "if_required";
  }): Promise<
    | { type: "success"; session: CheckoutSession }
    | { type: "error"; error: { message: string } }
  >;
}
export interface CheckoutSdk {
  on(event: "change", callback: (session: CheckoutSession) => void): void;
  createPaymentElement(): {
    on(event: "loaderror", callback: () => void): void;
    mount(container: HTMLElement): void;
    destroy(): void;
  };
  loadActions(): Promise<
    | { type: "success"; actions: CheckoutActions }
    | { type: "error"; error: { message: string } }
  >;
}
export type CheckoutLoader = (
  key: string,
  options: { stripeAccount?: string },
) => Promise<{
  initCheckoutElementsSdk(
    options: StripeCheckoutElementsSdkOptions,
  ): CheckoutSdk;
} | null>;
export const stripeLoader: CheckoutLoader = loadStripe;
export const appearance: Appearance = {
  theme: "stripe",
  variables: {
    colorPrimary: "#286551",
    colorBackground: "#ffffff",
    colorText: "#1d302d",
    colorDanger: "#943c32",
    fontFamily:
      'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    borderRadius: "6px",
    spacingUnit: "4px",
  },
  rules: {
    ".Input": {
      borderColor: "#bfcfc4",
      boxShadow: "none",
      padding: "12px 13px",
    },
    ".Input:focus": { borderColor: "#286551", boxShadow: "0 0 0 3px #e5efe8" },
    ".Label": { fontWeight: "650", fontSize: "13px", marginBottom: "8px" },
  },
};
export interface CheckoutState {
  phase:
    | "idle"
    | "loading"
    | "ready"
    | "submitting"
    | "error"
    | "pending"
    | "complete";
  amount: string;
  currency: string;
  error: string;
  canConfirm: boolean;
}
export const emptyCheckoutState: CheckoutState = {
  phase: "idle",
  amount: "",
  currency: "",
  error: "",
  canConfirm: false,
};

export class CheckoutController {
  state: CheckoutState = { ...emptyCheckoutState };
  private revision = 0;
  private details: ElementsCheckout | null = null;
  private element: ReturnType<CheckoutSdk["createPaymentElement"]> | null =
    null;
  private actions: CheckoutActions | null = null;
  private loader: CheckoutLoader;
  private changed: (state: CheckoutState) => void;
  constructor(loader: CheckoutLoader, changed: (state: CheckoutState) => void) {
    this.loader = loader;
    this.changed = changed;
  }
  private update(patch: Partial<CheckoutState>) {
    this.state = { ...this.state, ...patch };
    this.changed(this.state);
  }
  private release() {
    if (this.details) this.details.clientSecret = "";
    this.details = null;
    this.actions = null;
    this.element?.destroy();
    this.element = null;
  }
  private sync(session: CheckoutSession) {
    if (session.status.type === "expired") {
      this.revision++;
      this.release();
      this.update({
        phase: "error",
        error: "This checkout session expired. Start again to continue.",
        canConfirm: false,
      });
      return false;
    }
    this.update({
      amount: session.total.total.amount,
      currency: session.currency,
      canConfirm: session.canConfirm && session.status.type === "open",
    });
    return true;
  }
  async start(
    details: ElementsCheckout,
    container: HTMLElement,
    email: string,
  ) {
    this.dispose();
    const revision = this.revision;
    this.details = details;
    this.update({ phase: "loading" });
    try {
      const stripe = await this.loader(details.publishableKey, {
        ...(details.stripeAccount ? { stripeAccount: details.stripeAccount } : {}),
      });
      if (revision !== this.revision) return;
      if (!stripe) throw Error("Stripe unavailable");
      const sdk = stripe.initCheckoutElementsSdk({
        clientSecret: details.clientSecret,
        elementsOptions: { appearance },
        defaultValues: { email },
      });
      details.clientSecret = "";
      this.element = sdk.createPaymentElement();
      this.element.on("loaderror", () => {
        if (revision !== this.revision || !this.element) return;
        this.revision++;
        this.release();
        this.update({
          phase: "error",
          error: "Payment form could not load. Try again.",
          canConfirm: false,
        });
      });
      this.element.mount(container);
      const result = await sdk.loadActions();
      if (revision !== this.revision) return;
      if (result.type === "error") {
        this.release();
        this.update({ phase: "error", error: result.error.message });
        return;
      }
      this.actions = result.actions;
      if (!this.sync(this.actions.getSession())) return;
      sdk.on("change", (session) => {
        if (revision === this.revision && this.actions) this.sync(session);
      });
      this.update({ phase: "ready" });
    } catch {
      if (revision !== this.revision) return;
      this.release();
      this.update({
        phase: "error",
        error: "Secure checkout could not load. Try again.",
      });
    }
  }
  async confirm() {
    if (
      this.state.phase !== "ready" ||
      !this.state.canConfirm ||
      !this.actions ||
      !this.details
    )
      return;
    const revision = this.revision;
    this.update({ phase: "submitting", error: "" });
    try {
      const result = await this.actions.confirm({
        returnUrl: this.details.returnUrl,
        redirect: "if_required",
      });
      if (revision !== this.revision) return;
      if (result.type === "error") {
        this.update({ phase: "ready", error: result.error.message });
        return;
      }
      if (!this.sync(result.session)) return;
      const complete =
        result.session.status.type === "complete" &&
        result.session.status.paymentStatus !== "unpaid";
      this.release();
      this.update({
        phase: complete ? "complete" : "pending",
        canConfirm: false,
      });
    } catch {
      if (revision !== this.revision) return;
      this.update({
        phase: "ready",
        error: "Payment could not be submitted. Try again.",
      });
    }
  }
  dispose() {
    this.revision++;
    this.release();
    this.update({ ...emptyCheckoutState });
  }
}

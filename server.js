require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const { getOrCreateUser, setUserPlan, deductMinutes } = require("./db");
const auth = require("./auth");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const PORT = process.env.PORT || 4242;
// Used for redirect targets (Stripe success/cancel/portal return) — the
// primary custom domain now that we own one, not a vercel.app alias.
const CLIENT_URL = process.env.CLIENT_URL || "https://clipmindapp.net";

// CORS needs every domain the frontend can actually be loaded from, not just
// the primary one — this list previously only had the old vercel.app alias,
// which silently broke every API call once clipmindapp.net went live.
const ALLOWED_ORIGINS = [
  "http://localhost:5199",
  "https://clipmindapp.net",
  "https://www.clipmindapp.net",
  "https://clipmind-swart.vercel.app",
  "https://clipmindai.vercel.app",
  "https://clipmind-app.vercel.app",
  "https://clipmindapp.vercel.app",
  "https://getclipmind.vercel.app",
  "https://clipmind-video.vercel.app",
];

const PLANS = {
  starter: { name: "ClipMind Starter", price: 900, minutes: 150 },
  pro: { name: "ClipMind Pro", price: 2400, minutes: 400 },
  business: { name: "ClipMind Business", price: 5900, minutes: 1000 },
};

const app = express();
app.use(cors({ origin: ALLOWED_ORIGINS }));

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

app.post("/api/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const signature = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("[stripe] webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const planId = session.metadata?.planId;
    const email = normalizeEmail(session.metadata?.email || session.customer_details?.email || session.customer_email);
    const plan = PLANS[planId];

    if (email && plan) {
      setUserPlan(email, planId, plan.minutes, session.customer);
      console.log(`[stripe] subscription persisted via webhook: ${email} -> ${planId}`);
    } else {
      console.warn("[stripe] checkout.session.completed missing email or unknown plan, skipped persistence");
    }
  }

  res.json({ received: true });
});

app.use(express.json());

app.post("/api/auth/request-code", async (req, res) => {
  try {
    const email = await auth.requestCode(req.body?.email);
    res.json({ ok: true, email });
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error("[auth] request-code failed:", err.message);
    res.status(status).json({ error: err.message });
  }
});

app.post("/api/auth/google", async (req, res) => {
  try {
    const { email, token } = await auth.verifyGoogleCredential(req.body?.credential);
    res.json({ token, user: getOrCreateUser(email) });
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error("[auth] google sign-in failed:", err.message);
    res.status(status).json({ error: err.message });
  }
});

app.post("/api/auth/verify-code", (req, res) => {
  try {
    const { email, token } = auth.verifyCode(req.body?.email, req.body?.code);
    const user = getOrCreateUser(email);
    res.json({ token, user });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// The plan (and the minutes it grants) is now keyed to a verified session.
// Previously any caller could pass any email and be handed that account's
// plan — including the owner's unlimited one.
app.get("/api/me", (req, res) => {
  const email = auth.emailFromRequest(req);
  if (!email) return res.status(401).json({ error: "unauthorized" });
  res.json(getOrCreateUser(email));
});

app.post("/api/deduct-minutes", (req, res) => {
  const email = auth.emailFromRequest(req);
  if (!email) return res.status(401).json({ error: "unauthorized" });
  const minutes = Number(req.body?.minutes);
  if (!Number.isFinite(minutes)) {
    return res.status(400).json({ error: "minutes required" });
  }
  res.json(deductMinutes(email, minutes));
});

app.post("/api/create-checkout-session", async (req, res) => {
  const { planId } = req.body || {};
  const email = normalizeEmail(req.body?.email);
  const plan = PLANS[planId];

  if (!plan) {
    return res.status(400).json({ error: "Unknown plan" });
  }
  if (!email) {
    return res.status(400).json({ error: "Email required" });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      customer_email: email,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: plan.name },
            unit_amount: plan.price,
            recurring: { interval: "month" },
          },
          quantity: 1,
        },
      ],
      metadata: { planId, email },
      success_url: `${CLIENT_URL}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${CLIENT_URL}/?checkout=cancelled`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("[stripe] failed to create checkout session:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/create-portal-session", async (req, res) => {
  // A Stripe portal URL authenticates by possession alone: it exposes invoice
  // history, the card's last four and the ability to cancel. Taking the email
  // from the body let anyone who knew an address open that customer's console.
  const email = auth.emailFromRequest(req);
  if (!email) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const user = getOrCreateUser(email);
  if (!user.stripeCustomerId) {
    return res.status(400).json({ error: "no_subscription" });
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: CLIENT_URL,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("[stripe] failed to create portal session:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/checkout-session/:id", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.id);
    const planId = session.metadata?.planId;
    const email = normalizeEmail(session.metadata?.email || session.customer_details?.email || session.customer_email);
    const plan = PLANS[planId];

    let persistedUser = null;
    if (session.payment_status === "paid" && email && plan) {
      persistedUser = setUserPlan(email, planId, plan.minutes, session.customer);
    }

    res.json({
      status: session.payment_status,
      planId,
      email,
      minutes: persistedUser ? persistedUser.minutesLeft : plan ? plan.minutes : null,
    });
  } catch (err) {
    res.status(404).json({ error: "Session not found" });
  }
});

app.listen(PORT, () => {
  console.log(`ClipMind billing server running at http://localhost:${PORT}`);
});

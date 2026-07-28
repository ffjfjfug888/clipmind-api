const crypto = require("crypto");

// Codes and sessions live in memory. Render restarts wipe them, which only
// means a user has to request a fresh code — worth it to avoid dragging a
// database into a service whose whole state is one JSON file.
const codes = new Map(); // email -> { hash, expiresAt, attempts, sentAt }
const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 45 * 1000;
const MAX_ATTEMPTS = 5;
const SESSION_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM || "ClipMind <login@clipmindapp.net>";
// Sessions are signed rather than stored, so they survive restarts. Falling
// back to a random secret means tokens simply stop validating after a restart
// instead of being forgeable, which is the safe direction to fail.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function hashCode(email, code) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(`${email}:${code}`).digest("hex");
}

function generateCode() {
  // crypto.randomInt avoids the modulo bias a Math.random()-based digit would have.
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function signSession(email) {
  const payload = Buffer.from(
    JSON.stringify({ email, exp: Date.now() + SESSION_TTL_MS })
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  // timingSafeEqual throws on length mismatch, so compare lengths first.
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, and it measures BYTES — a
  // string-length check passes for multi-byte input of the same char count.
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!data.email || !data.exp || Date.now() > data.exp) return null;
    return data.email;
  } catch {
    return null;
  }
}

async function sendCodeEmail(email, code) {
  if (!RESEND_API_KEY) {
    // Without a key there is no way to deliver the code, so fail loudly rather
    // than pretending the email was sent.
    throw new Error("email_not_configured");
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: [email],
      subject: `${code} — ClipMind login code`,
      text: `Your ClipMind login code is ${code}. It expires in 10 minutes.\n\nIf you didn't request it, ignore this email.`,
      html: `<div style="font-family:system-ui,sans-serif;background:#050508;color:#fff;padding:32px;border-radius:16px">
  <p style="color:#9ca3af;font-size:14px;margin:0 0 8px">ClipMind login code</p>
  <p style="font-size:38px;font-weight:700;letter-spacing:8px;margin:0 0 16px;font-family:ui-monospace,monospace">${code}</p>
  <p style="color:#6b7280;font-size:13px;margin:0">Expires in 10 minutes. If you didn't request it, ignore this email.</p>
</div>`,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`resend_failed_${res.status}:${body.slice(0, 200)}`);
  }
}

// The OAuth client id is public by design — it ships inside the frontend
// bundle — so a literal default is safe and saves an extra deploy-time setting.
const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_OAUTH_CLIENT_ID ||
  "27933207508-9kldpnd6fbc3attvfssootr40smgmrkj.apps.googleusercontent.com";

// Google's tokeninfo endpoint validates the signature and expiry for us; we
// still have to check the audience ourselves, otherwise a token minted for a
// DIFFERENT Google app would be accepted here.
async function verifyGoogleCredential(credential) {
  if (typeof credential !== "string" || credential.length < 20) {
    throw Object.assign(new Error("bad_google_token"), { status: 400 });
  }

  const res = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`
  );
  if (!res.ok) {
    throw Object.assign(new Error("bad_google_token"), { status: 401 });
  }

  const info = await res.json();
  if (info.aud !== GOOGLE_CLIENT_ID) {
    throw Object.assign(new Error("bad_google_token"), { status: 401 });
  }
  if (info.email_verified !== "true" && info.email_verified !== true) {
    throw Object.assign(new Error("google_email_unverified"), { status: 401 });
  }

  const email = normalizeEmail(info.email);
  if (!email) {
    throw Object.assign(new Error("bad_google_token"), { status: 401 });
  }
  return { email, token: signSession(email) };
}

// Per-email cooldown alone let one caller walk a list of addresses and mail a
// code to each, so the sender is rate limited too — and the code map is swept,
// since an unbounded Map is its own denial of service.
const senders = new Map(); // ip -> { count, windowStart }
const SENDER_WINDOW_MS = 60 * 60 * 1000;
const SENDER_MAX_PER_WINDOW = 20;

function sweepExpired() {
  const now = Date.now();
  for (const [key, entry] of codes) {
    if (now > entry.expiresAt + CODE_TTL_MS) codes.delete(key);
  }
  for (const [key, entry] of senders) {
    if (now - entry.windowStart > SENDER_WINDOW_MS) senders.delete(key);
  }
}

async function requestCode(rawEmail, senderKey) {
  sweepExpired();

  const email = normalizeEmail(rawEmail);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw Object.assign(new Error("invalid_email"), { status: 400 });
  }

  if (senderKey) {
    const now = Date.now();
    const seen = senders.get(senderKey);
    if (!seen || now - seen.windowStart > SENDER_WINDOW_MS) {
      senders.set(senderKey, { count: 1, windowStart: now });
    } else if (seen.count >= SENDER_MAX_PER_WINDOW) {
      throw Object.assign(new Error("too_many_requests"), { status: 429 });
    } else {
      seen.count += 1;
    }
  }

  const existing = codes.get(email);
  if (existing && Date.now() - existing.sentAt < RESEND_COOLDOWN_MS) {
    throw Object.assign(new Error("too_soon"), { status: 429 });
  }

  const code = generateCode();
  codes.set(email, {
    hash: hashCode(email, code),
    expiresAt: Date.now() + CODE_TTL_MS,
    attempts: 0,
    sentAt: Date.now(),
  });

  await sendCodeEmail(email, code);
  return email;
}

function verifyCode(rawEmail, rawCode) {
  const email = normalizeEmail(rawEmail);
  const code = String(rawCode || "").trim();
  const entry = codes.get(email);

  if (!entry || Date.now() > entry.expiresAt) {
    codes.delete(email);
    throw Object.assign(new Error("code_expired"), { status: 400 });
  }
  if (entry.attempts >= MAX_ATTEMPTS) {
    codes.delete(email);
    throw Object.assign(new Error("too_many_attempts"), { status: 429 });
  }

  entry.attempts += 1;
  const candidate = hashCode(email, code);
  if (candidate.length !== entry.hash.length ||
      !crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(entry.hash))) {
    throw Object.assign(new Error("bad_code"), { status: 400 });
  }

  codes.delete(email);
  return { email, token: signSession(email) };
}

// Reads the caller's identity from the Authorization header. Returns null when
// absent or invalid so callers decide whether that's fatal.
function emailFromRequest(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return null;
  return verifySession(header.slice(7));
}

module.exports = {
  normalizeEmail,
  requestCode,
  verifyCode,
  verifyGoogleCredential,
  verifySession,
  emailFromRequest,
  GOOGLE_CLIENT_ID,
  isConfigured: () => Boolean(RESEND_API_KEY),
};

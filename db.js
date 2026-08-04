const fs = require("fs");
const path = require("path");

// Render's filesystem is ephemeral — it is wiped on every deploy and restart,
// which silently erased every paid plan stored in users.json. Records now live
// in the video service's private bucket, reached over an authenticated
// endpoint; the local file is kept only as a cache and last-resort fallback so
// billing still answers if that service is briefly unreachable.
const DB_PATH = path.join(__dirname, "users.json");
const STORE_URL =
  process.env.STORE_URL || "https://clipmind-video-27933207508.us-central1.run.app";
const SERVICE_SECRET = process.env.SESSION_SECRET;

const OWNER_EMAILS = (process.env.OWNER_EMAILS || "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

function ownerUser(email) {
  return {
    email,
    planId: "owner",
    minutesTotal: 999999,
    minutesLeft: 999999,
    stripeCustomerId: null,
    updatedAt: new Date().toISOString(),
  };
}

function defaultUser(email) {
  return {
    email,
    planId: "free",
    // Must match the free tier the site advertises (PLANS.free.minutes = 10 in
    // ClipMindApp.jsx). This sat at 30, so every new signup silently got three
    // times the intended free allowance.
    minutesTotal: 10,
    minutesLeft: 10,
    stripeCustomerId: null,
    updatedAt: new Date().toISOString(),
  };
}

function readLocal() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeLocal(users) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(users, null, 2));
  } catch {
    // A read-only or full disk must not break billing — the store is upstream.
  }
}

async function remoteGet(email) {
  if (!SERVICE_SECRET) return null;
  try {
    const res = await fetch(`${STORE_URL}/api/store/user?email=${encodeURIComponent(email)}`, {
      headers: { "x-clipmind-service": SERVICE_SECRET },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`store_${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn(`[db] remote read failed for ${email}: ${err.message}`);
    return undefined; // undefined = unknown, distinct from null = definitely absent
  }
}

async function remotePut(email, user) {
  if (!SERVICE_SECRET) return;
  try {
    const res = await fetch(`${STORE_URL}/api/store/user`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-clipmind-service": SERVICE_SECRET },
      body: JSON.stringify({ email, user }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`store_${res.status}`);
  } catch (err) {
    console.error(`[db] remote write failed for ${email}: ${err.message}`);
  }
}

async function loadUser(email) {
  const remote = await remoteGet(email);
  if (remote) return remote;

  const local = readLocal()[email];
  // Only treat "definitely absent upstream" as a reason to create a fresh
  // record; a failed lookup falls back to whatever this instance still has.
  if (remote === null && !local) return null;
  return local || null;
}

async function saveUser(email, user) {
  const users = readLocal();
  users[email] = user;
  writeLocal(users);
  await remotePut(email, user);
  return user;
}

async function getOrCreateUser(email) {
  if (OWNER_EMAILS.includes(email)) return ownerUser(email);
  const existing = await loadUser(email);
  if (existing) return existing;
  return saveUser(email, defaultUser(email));
}

async function setUserPlan(email, planId, minutesTotal, stripeCustomerId) {
  const existing = await loadUser(email);
  return saveUser(email, {
    email,
    planId,
    minutesTotal,
    minutesLeft: minutesTotal,
    stripeCustomerId: stripeCustomerId || existing?.stripeCustomerId || null,
    updatedAt: new Date().toISOString(),
  });
}

async function deductMinutes(email, minutes) {
  if (OWNER_EMAILS.includes(email)) return ownerUser(email);
  const user = (await loadUser(email)) || defaultUser(email);
  return saveUser(email, {
    ...user,
    minutesLeft: Math.max(0, user.minutesLeft - minutes),
    updatedAt: new Date().toISOString(),
  });
}

// Top-ups ADD to the balance and leave the plan alone — buying extra minutes
// must not silently change which tier someone is on, or reset their renewal.
async function addMinutes(email, minutes) {
  const extra = Math.max(0, Math.round(Number(minutes) || 0));
  if (!extra) return loadUser(email);
  const user = (await loadUser(email)) || defaultUser(email);
  return saveUser(email, {
    ...user,
    minutesLeft: (user.minutesLeft || 0) + extra,
    minutesTotal: (user.minutesTotal || 0) + extra,
    updatedAt: new Date().toISOString(),
  });
}

module.exports = { getOrCreateUser, setUserPlan, deductMinutes, addMinutes };

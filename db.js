const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "users.json");

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

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeAll(users) {
  fs.writeFileSync(DB_PATH, JSON.stringify(users, null, 2));
}

function defaultUser(email) {
  return {
    email,
    planId: "free",
    minutesTotal: 30,
    minutesLeft: 30,
    stripeCustomerId: null,
    updatedAt: new Date().toISOString(),
  };
}

function getOrCreateUser(email) {
  if (OWNER_EMAILS.includes(email)) return ownerUser(email);
  const users = readAll();
  if (!users[email]) {
    users[email] = defaultUser(email);
    writeAll(users);
  }
  return users[email];
}

function setUserPlan(email, planId, minutesTotal, stripeCustomerId) {
  const users = readAll();
  const existing = users[email];
  users[email] = {
    email,
    planId,
    minutesTotal,
    minutesLeft: minutesTotal,
    stripeCustomerId: stripeCustomerId || existing?.stripeCustomerId || null,
    updatedAt: new Date().toISOString(),
  };
  writeAll(users);
  return users[email];
}

function deductMinutes(email, minutes) {
  if (OWNER_EMAILS.includes(email)) return ownerUser(email);
  const users = readAll();
  const user = users[email] || defaultUser(email);
  user.minutesLeft = Math.max(0, user.minutesLeft - minutes);
  user.updatedAt = new Date().toISOString();
  users[email] = user;
  writeAll(users);
  return user;
}

module.exports = { getOrCreateUser, setUserPlan, deductMinutes };

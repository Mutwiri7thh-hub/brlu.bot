require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");

// ========================================
// CONFIG
// ========================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PORT = Number(process.env.PORT) || 3000;
const PREMIUM_CHANNEL_ID = "-1004322547397";
const ADMIN_ID = 845159429;

if (!BOT_TOKEN || !PAYSTACK_SECRET_KEY) {
  throw new Error("Please set BOT_TOKEN and PAYSTACK_SECRET_KEY in your .env file.");
}

// ========================================
// BOT + EXPRESS
// ========================================
const bot = new Telegraf(BOT_TOKEN);
const app = express();

// ========================================
// FILE STORAGE
// ========================================
const SUBSCRIPTIONS_FILE = "./subscriptions.json";
const MPESA_FILE = "./mpesa_requests.json";
const CRYPTO_FILE = "./crypto_requests.json";
const STARS_FILE = "./stars_requests.json";

function loadJSON(file) {
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, "{}");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`❌ Error loading ${file}:`, error.message);
    return {};
  }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let subscriptions = loadJSON(SUBSCRIPTIONS_FILE);
let mpesaRequests = loadJSON(MPESA_FILE);
let cryptoRequests = loadJSON(CRYPTO_FILE);
let starsRequests = loadJSON(STARS_FILE);

// ========================================
// TEMPORARY STATE
// ========================================
const pendingMpesaPlans = new Map();

// ========================================
// PLANS
// ========================================
const PLANS = {
  week: { name: "1 Week", price: 100, stars: 100, days: 7 },
  two_weeks: { name: "2 Weeks", price: 170, stars: 170, days: 14 },
  month: { name: "1 Month", price: 350, stars: 350, days: 30 },
  three_months: { name: "3 Months", price: 650, stars: 650, days: 90 },
};

// ========================================
// HELPERS
// ========================================
function getFullName(user) {
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || "Customer";
}

function getUserName(ctx) {
  return ctx.from.first_name || ctx.from.username || "Customer";
}

function formatDate(timestamp) {
  if (!timestamp) return "Unknown";
  return new Date(timestamp).toLocaleString("en-KE", {
    timeZone: "Africa/Nairobi",
  });
}

async function notifyAdmin(message) {
  try {
    await bot.telegram.sendMessage(ADMIN_ID, message);
  } catch (error) {
    console.error("❌ Admin notification failed:", error.message);
  }
}

// ========================================
// ACTIVATE SUBSCRIPTION
// ========================================
function activateSubscription(userId, planId) {
  const plan = PLANS[planId];
  if (!plan) throw new Error(`Unknown plan: ${planId}`);

  const now = Date.now();
  let startTime = now;

  if (subscriptions[userId]?.expiresAt > now) {
    startTime = subscriptions[userId].expiresAt;
  }

  const expiresAt = startTime + plan.days * 24 * 60 * 60 * 1000;

  subscriptions[userId] = {
    userId: String(userId),
    planId,
    planName: plan.name,
    startedAt: subscriptions[userId]?.startedAt || now,
    expiresAt,
  };

  saveJSON(SUBSCRIPTIONS_FILE, subscriptions);
  console.log(`✅ Subscription activated: ${userId} - ${plan.name}`);
  return subscriptions[userId];
}

// ========================================
// CREATE ONE-TIME PREMIUM INVITE
// ========================================
async function createPremiumInvite(userId) {
  console.log("🔗 Creating one-time premium invite...");

  const invite = await bot.telegram.createChatInviteLink(
    PREMIUM_CHANNEL_ID,
    {
      member_limit: 1,
      expire_date: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
      name: `Member ${userId}`,
    }
  );

  console.log("✅ Premium invite created");
  return invite.invite_link;
}

// ========================================
// SEND PREMIUM INVITE
// ========================================
async function sendPremiumInvite(userId, inviteLink) {
  await bot.telegram.sendMessage(
    userId,
    `🎉 PAYMENT CONFIRMED!\n\n` +
      `Your premium subscription is now active.\n\n` +
      `🔐 YOUR ONE-TIME INVITE LINK:\n\n${inviteLink}\n\n` +
      `⚠️ Do not share this link. It can only be used once.`
  );
}

// ========================================
// PAYSTACK SUCCESS HANDLER
// ========================================
async function handlePaystackSuccess(payment) {
  try {
    console.log("\n==============================");
    console.log("💰 PAYSTACK PAYMENT SUCCESS");
    console.log("==============================");
    console.log("Reference:", payment.reference);
    console.log("Status:", payment.status);
    console.log("Amount:", payment.amount);
    console.log("Currency:", payment.currency);

    const reference = payment.reference;

    if (!reference) {
      console.log("❌ Payment has no reference");
      return;
    }

    const request = mpesaRequests[reference];

    if (!request) {
      console.log("❌ Payment request not found:", reference);
      return;
    }

    if (request.status === "approved") {
      console.log("⚠️ Payment already approved");
      return;
    }

    if (payment.status !== "success") {
      console.log("⚠️ Payment is not successful:", payment.status);
      return;
    }

    if (payment.currency !== "KES") {
      console.log("❌ Currency mismatch:", payment.currency);
      return;
    }

    const expectedAmount = Number(request.amount) * 100;

    if (Number(payment.amount) !== expectedAmount) {
      console.log("❌ Amount mismatch");
      return;
    }

    const userId = String(request.userId);
    const subscription = activateSubscription(userId, request.planId);

    let inviteLink;

    try {
      inviteLink = await createPremiumInvite(userId);
    } catch (error) {
      console.error(
        "❌ INVITE CREATION ERROR:",
        error.response?.data || error.message
      );

      request.status = "paid_invite_failed";
      request.error = error.response?.data || error.message;
      request.payment = payment;

      saveJSON(MPESA_FILE, mpesaRequests);

      await notifyAdmin(
        `⚠️ PAYMENT CONFIRMED BUT INVITE FAILED\n\n` +
          `👤 Name: ${request.name}\n` +
          `🆔 User ID: ${userId}\n` +
          `👤 Username: @${request.username || "none"}\n` +
          `📱 Phone: ${request.phone}\n\n` +
          `📦 Plan: ${request.planName}\n` +
          `💰 Amount: KES ${request.amount}\n` +
          `🧾 Reference: ${reference}`
      );

      return;
    }

    request.status = "approved";
    request.approvedAt = Date.now();
    request.payment = payment;
    request.inviteLink = inviteLink;
    request.subscriptionExpiresAt = subscription.expiresAt;

    saveJSON(MPESA_FILE, mpesaRequests);

    try {
      await sendPremiumInvite(userId, inviteLink);
      console.log(`✅ Invite sent to ${userId}`);
    } catch (error) {
      console.error(
        "❌ CUSTOMER MESSAGE ERROR:",
        error.response?.description || error.message
      );

      await notifyAdmin(
        `⚠️ PAYMENT APPROVED BUT CUSTOMER MESSAGE FAILED\n\n` +
          `👤 User ID: ${userId}\n` +
          `👤 Username: @${request.username || "none"}\n` +
          `📦 Plan: ${request.planName}\n` +
          `💰 Amount: KES ${request.amount}\n` +
          `🧾 Reference: ${reference}\n\n` +
          `🔗 Invite link:\n${inviteLink}`
      );

      return;
    }

    await notifyAdmin(
      `✅ PAYMENT APPROVED\n\n` +
        `👤 Name: ${request.name}\n` +
        `🆔 User ID: ${userId}\n` +
        `👤 Username: @${request.username || "none"}\n` +
        `📱 Phone: ${request.phone}\n\n` +
        `📦 Plan: ${request.planName}\n` +
        `💰 Amount: KES ${request.amount}\n` +
        `🧾 Reference: ${reference}\n\n` +
        `⏳ Expires:\n${formatDate(subscription.expiresAt)}`
    );

    console.log("🎉 PAYMENT FULLY PROCESSED");
  } catch (error) {
    console.error(
      "❌ SUCCESS HANDLER ERROR:",
      error.response?.data || error.message
    );
  }
}

// ========================================
// START COMMAND
// ========================================
bot.start(async (ctx) => {
  try {
    const user = ctx.from;

    if (user.id !== ADMIN_ID) {
      await notifyAdmin(
        `🆕 NEW BOT USER!\n\n` +
          `👤 Name: ${getFullName(user)}\n` +
          `🔹 Username: ${user.username ? "@" + user.username : "No username"}\n` +
          `🆔 Telegram ID: ${user.id}\n\n` +
          `📅 Started: ${formatDate(Date.now())}\n\n` +
          `🤖 BRLU Premium Bot`
      );
    }

    await ctx.reply(
      `🔥 BRLU PREMIUM\n\nWelcome ${getUserName(ctx)}!\n\nChoose your premium plan:`,
      Markup.inlineKeyboard([
        [Markup.button.callback("⭐ 1 Week — KES 100", "plan_week")],
        [Markup.button.callback("⭐ 2 Weeks — KES 170", "plan_two_weeks")],
        [Markup.button.callback("⭐ 1 Month — KES 350", "plan_month")],
        [Markup.button.callback("⭐ 3 Months — KES 650", "plan_three_months")],
        [Markup.button.callback("👤 My Profile", "my_profile")],
      ])
    );
  } catch (error) {
    console.error("❌ START COMMAND ERROR:", error.message);
    await ctx.reply("Something went wrong. Please try again.");
  }
});

// ========================================
// PLAN SELECTION
// ========================================
bot.action(/^plan_(week|two_weeks|month|three_months)$/, async (ctx) => {
  try {
    const planId = ctx.match[1];
    const plan = PLANS[planId];

    await ctx.answerCbQuery();

    await ctx.reply(
      `📦 ${plan.name}\n💰 KES ${plan.price}\n⭐ ${plan.stars} Stars\n\nChoose your payment method:`,
      Markup.inlineKeyboard([
        [Markup.button.callback("📱 M-PESA", `mpesa_${planId}`)],
        [Markup.button.callback("⭐ Telegram Stars", `stars_${planId}`)],
        [Markup.button.callback("₿ Crypto", `crypto_${planId}`)],
      ])
    );
  } catch (error) {
    console.error("❌ PLAN BUTTON ERROR:", error.message);
  }
});

// ========================================
// M-PESA BUTTON
// ========================================
bot.action(/^mpesa_(week|two_weeks|month|three_months)$/, async (ctx) => {
  try {
    const planId = ctx.match[1];
    const plan = PLANS[planId];

    pendingMpesaPlans.set(ctx.from.id, planId);

    await ctx.answerCbQuery();

    await ctx.reply(
      `📱 M-PESA PAYMENT\n\nPlan: ${plan.name}\nAmount: KES ${plan.price}\n\n` +
        `Please enter your M-PESA phone number.\n\nExample: 0712345678`
    );

    console.log(`📱 Waiting for M-PESA phone from ${ctx.from.id}`);
  } catch (error) {
    console.error(
      "❌ M-PESA BUTTON ERROR:",
      error.response?.data || error.message
    );

    try {
      await ctx.answerCbQuery("M-PESA button error");
    } catch {}
  }
});

// ========================================
// TEXT / PHONE HANDLER
// ========================================
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const planId = pendingMpesaPlans.get(userId);

  if (!planId) return;

  try {
    const plan = PLANS[planId];
    let phone = ctx.message.text.trim();

    if (phone.startsWith("07") && phone.length === 10) {
      // Kenyan local format accepted.
    } else if (phone.startsWith("01") && phone.length === 10) {
      // Kenyan local format accepted.
    } else if (phone.startsWith("+254") && phone.length === 13) {
      phone = "0" + phone.substring(4);
    } else if (phone.startsWith("254") && phone.length === 12) {
      phone = "0" + phone.substring(3);
    } else {
      await ctx.reply(
        "❌ Invalid Kenyan phone number. Please enter it like 0712345678."
      );
      return;
    }

    if (!/^(07|01)\d{8}$/.test(phone)) {
      await ctx.reply(
        "❌ Invalid phone number. Please enter it like 0712345678."
      );
      return;
    }

    pendingMpesaPlans.delete(userId);

    const reference = `BRLU_${userId}_${Date.now()}`;
    const email = `${userId}@brlu-premium.com`;

    mpesaRequests[reference] = {
      reference,
      userId: String(userId),
      username: ctx.from.username || "",
      name: getFullName(ctx.from),
      phone,
      planId,
      planName: plan.name,
      amount: plan.price,
      status: "initiated",
      createdAt: Date.now(),
    };

    saveJSON(MPESA_FILE, mpesaRequests);

    await ctx.reply(
      `📱 Sending M-PESA STK Push...\n\nPlan: ${plan.name}\nAmount: KES ${plan.price}\n\n` +
        `Check your phone and enter your M-PESA PIN when prompted.`
    );

    const response = await axios.post(
      "https://api.paystack.co/charge",
      {
        email,
        amount: plan.price * 100,
        currency: "KES",
        reference,
        mobile_money: {
          phone: "+254" + phone.substring(1),
          provider: "mpesa",
        },
        metadata: {
          telegram_user_id: String(userId),
          telegram_username: ctx.from.username || "",
          telegram_name: getFullName(ctx.from),
          plan_id: planId,
          plan_name: plan.name,
          amount_kes: plan.price,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("\n📡 PAYSTACK RESPONSE:");
    console.log(JSON.stringify(response.data, null, 2));

    mpesaRequests[reference].status =
      response.data?.data?.status || response.data?.status || "pending";

    mpesaRequests[reference].paystackResponse = response.data;

    saveJSON(MPESA_FILE, mpesaRequests);

    // UPDATED: Short confirmation message only.
    await ctx.reply("✅ M-PESA request sent.");
  } catch (error) {
    console.error(
      "❌ M-PESA PAYMENT ERROR:",
      error.response?.data || error.message
    );

    pendingMpesaPlans.delete(userId);

    await ctx.reply(
      `❌ M-PESA payment could not be started.\n\n${error.response?.data?.message || "Please try again."}`
    );
  }
});

// ========================================
// TELEGRAM STARS INVOICE
// ========================================
bot.action(/^stars_(week|two_weeks|month|three_months)$/, async (ctx) => {
  try {
    const planId = ctx.match[1];
    const plan = PLANS[planId];

    await ctx.answerCbQuery();

    const payload = `brlu_stars:${ctx.from.id}:${planId}:${Date.now()}`;

    await ctx.replyWithInvoice({
      title: `BRLU Premium - ${plan.name}`,
      description: `Premium channel access for ${plan.days} days.`,
      payload,
      provider_token: "",
      currency: "XTR",
      prices: [
        {
          label: plan.name,
          amount: plan.stars,
        },
      ],
    });

    console.log(`⭐ Stars invoice sent to ${ctx.from.id}: ${plan.name}`);
  } catch (error) {
    console.error("❌ STARS INVOICE ERROR:", error.message);
    await ctx.reply("❌ Could not create Stars invoice. Please try again.");
  }
});

// ========================================
// TELEGRAM STARS PRE-CHECKOUT
// ========================================
bot.on("pre_checkout_query", async (ctx) => {
  try {
    const query = ctx.preCheckoutQuery;
    const parts = query.invoice_payload.split(":");

    if (parts.length !== 4 || parts[0] !== "brlu_stars") {
      return ctx.answerPreCheckoutQuery(false, "Invalid payment details.");
    }

    const [, userId, planId] = parts;
    const plan = PLANS[planId];

    if (
      !plan ||
      userId !== String(query.from.id) ||
      query.currency !== "XTR" ||
      Number(query.total_amount) !== plan.stars
    ) {
      return ctx.answerPreCheckoutQuery(
        false,
        "Payment details do not match. Please try again."
      );
    }

    await ctx.answerPreCheckoutQuery(true);
  } catch (error) {
    console.error("❌ STARS PRE-CHECKOUT ERROR:", error.message);

    try {
      await ctx.answerPreCheckoutQuery(
        false,
        "Unable to verify payment. Please try again."
      );
    } catch {}
  }
});

// ========================================
// TELEGRAM STARS SUCCESSFUL PAYMENT
// ========================================
bot.on("message", async (ctx, next) => {
  const payment = ctx.message.successful_payment;

  if (!payment) return next();

  try {
    const userId = String(ctx.from.id);
    const parts = payment.invoice_payload.split(":");

    if (parts.length !== 4 || parts[0] !== "brlu_stars") {
      await ctx.reply("❌ Invalid payment details. Please contact support.");
      return;
    }

    const [, invoiceUserId, planId] = parts;
    const plan = PLANS[planId];

    if (
      !plan ||
      invoiceUserId !== userId ||
      payment.currency !== "XTR" ||
      Number(payment.total_amount) !== plan.stars
    ) {
      await ctx.reply("❌ Payment verification failed. Please contact support.");
      return;
    }

    const chargeId = payment.telegram_payment_charge_id;

    if (!chargeId) {
      await ctx.reply("❌ Missing payment reference. Please contact support.");
      return;
    }

    if (starsRequests[chargeId]) {
      await ctx.reply("⚠️ This payment has already been processed.");
      return;
    }

    // Save payment before processing.
    starsRequests[chargeId] = {
      chargeId,
      userId,
      planId,
      planName: plan.name,
      stars: plan.stars,
      currency: payment.currency,
      status: "paid",
      createdAt: Date.now(),
      payment,
    };

    saveJSON(STARS_FILE, starsRequests);

    const subscription = activateSubscription(userId, planId);

    starsRequests[chargeId].status = "approved";
    starsRequests[chargeId].approvedAt = Date.now();
    starsRequests[chargeId].subscriptionExpiresAt = subscription.expiresAt;

    saveJSON(STARS_FILE, starsRequests);

    let inviteLink;

    try {
      inviteLink = await createPremiumInvite(userId);

      starsRequests[chargeId].inviteLink = inviteLink;
      starsRequests[chargeId].inviteSent = true;
      saveJSON(STARS_FILE, starsRequests);

      await sendPremiumInvite(userId, inviteLink);
    } catch (error) {
      console.error("❌ STARS INVITE ERROR:", error.message);

      starsRequests[chargeId].status = "paid_invite_failed";
      starsRequests[chargeId].error = error.message;
      saveJSON(STARS_FILE, starsRequests);

      await notifyAdmin(
        `⚠️ STARS PAYMENT CONFIRMED BUT INVITE FAILED\n\n` +
          `👤 Name: ${getFullName(ctx.from)}\n` +
          `🆔 User ID: ${userId}\n` +
          `📦 Plan: ${plan.name}\n` +
          `⭐ Stars: ${plan.stars}\n` +
          `🧾 Charge ID: ${chargeId}\n\n` +
          `Please recover the customer's invite manually.`
      );

      await ctx.reply(
        "✅ Your payment was received, but we could not create your invite. Please contact the admin."
      );
      return;
    }

    await notifyAdmin(
      `✅ TELEGRAM STARS PAYMENT APPROVED\n\n` +
        `👤 Name: ${getFullName(ctx.from)}\n` +
        `🆔 User ID: ${userId}\n` +
        `👤 Username: @${ctx.from.username || "none"}\n\n` +
        `📦 Plan: ${plan.name}\n` +
        `⭐ Stars: ${plan.stars}\n` +
        `🧾 Charge ID: ${chargeId}\n\n` +
        `⏳ Expires:\n${formatDate(subscription.expiresAt)}`
    );

    console.log(`✅ Stars payment processed: ${userId} - ${plan.name}`);
  } catch (error) {
    console.error("❌ STARS PAYMENT ERROR:", error.message);

    await ctx.reply(
      "⚠️ Your payment was received, but processing failed. Please contact the admin."
    );
  }
});

// ========================================
// CRYPTO
// ========================================
bot.action(/^crypto_(week|two_weeks|month|three_months)$/, async (ctx) => {
  try {
    const plan = PLANS[ctx.match[1]];

    await ctx.answerCbQuery();

    await ctx.reply(
      `₿ CRYPTO PAYMENT\n\nPlan: ${plan.name}\nAmount: KES ${plan.price}\n\n` +
        `Crypto payment instructions have not been connected yet.`
    );
  } catch (error) {
    console.error("❌ CRYPTO ERROR:", error.message);
  }
});

// ========================================
// PROFILE
// ========================================
async function sendProfile(ctx) {
  const userId = String(ctx.from.id);
  const subscription = subscriptions[userId];

  if (!subscription) {
    return ctx.reply(
      `👤 MEMBER PROFILE\n\nName: ${getFullName(ctx.from)}\n` +
        `User ID: ${userId}\nStatus: ❌ No active subscription`
    );
  }

  const active = subscription.expiresAt > Date.now();

  return ctx.reply(
    `👤 MEMBER PROFILE\n\nName: ${getFullName(ctx.from)}\n` +
      `User ID: ${userId}\n\n📦 Plan: ${subscription.planName}\n` +
      `Status: ${active ? "🟢 ACTIVE" : "🔴 EXPIRED"}\n` +
      `Expires: ${formatDate(subscription.expiresAt)}`
  );
}

bot.command("profile", sendProfile);

bot.action("my_profile", async (ctx) => {
  await ctx.answerCbQuery();
  await sendProfile(ctx);
});

// ========================================
// ADMIN RECOVERY: M-PESA
// Usage: /recover BRLU_REFERENCE
// ========================================
bot.command("recover", async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID) {
      return ctx.reply("❌ Admin only.");
    }

    const parts = ctx.message.text.trim().split(/\s+/);
    const reference = parts[1];

    if (!reference) {
      return ctx.reply("Usage:\n/recover BRLU_REFERENCE");
    }

    const request = mpesaRequests[reference];

    if (!request) {
      return ctx.reply(`❌ Reference not found:\n${reference}`);
    }

    if (request.status === "approved") {
      return ctx.reply("⚠️ This payment request is already approved.");
    }

    await ctx.reply(`🔎 Checking Paystack payment...\n\nReference:\n${reference}`);

    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        },
      }
    );

    const payment = response.data?.data;

    if (!payment) {
      return ctx.reply("❌ Paystack returned no transaction data.");
    }

    if (payment.status !== "success") {
      return ctx.reply(
        `⚠️ Payment is not confirmed as successful.\n\nPaystack status: ${payment.status}`
      );
    }

    if (payment.currency !== "KES") {
      return ctx.reply("❌ Currency mismatch.");
    }

    const expectedAmount = Number(request.amount) * 100;

    if (Number(payment.amount) !== expectedAmount) {
      return ctx.reply(
        `❌ Amount mismatch.\n\nExpected: KES ${request.amount}\nPaystack: KES ${Number(payment.amount) / 100}`
      );
    }

    const subscription = activateSubscription(request.userId, request.planId);
    const inviteLink = await createPremiumInvite(request.userId);

    request.status = "approved";
    request.recovered = true;
    request.approvedAt = Date.now();
    request.payment = payment;
    request.inviteLink = inviteLink;
    request.subscriptionExpiresAt = subscription.expiresAt;

    saveJSON(MPESA_FILE, mpesaRequests);

    await sendPremiumInvite(request.userId, inviteLink);

    await ctx.reply(
      `✅ PAYMENT RECOVERED SUCCESSFULLY\n\n` +
        `👤 Name: ${request.name}\n🆔 User ID: ${request.userId}\n` +
        `👤 Username: @${request.username || "none"}\n📱 Phone: ${request.phone}\n\n` +
        `📦 Plan: ${request.planName}\n💰 Amount: KES ${request.amount}\n` +
        `🧾 Reference: ${reference}\n\n🔗 One-time invite sent to customer.\n\n` +
        `⏳ Expires:\n${formatDate(subscription.expiresAt)}`
    );
  } catch (error) {
    console.error(
      "❌ RECOVERY ERROR:",
      error.response?.data || error.message
    );

    await ctx.reply(
      `❌ Recovery failed.\n\n${error.response?.data?.message || error.message}`
    );
  }
});

// ========================================
// ADMIN: LIST USERS
// ========================================
bot.command("users", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("❌ Admin only.");
  }

  const ids = Object.keys(subscriptions);

  if (!ids.length) {
    return ctx.reply("No subscriptions recorded yet.");
  }

  const list = ids.slice(0, 40).map((id, index) => {
    const sub = subscriptions[id];
    const active = sub.expiresAt > Date.now();

    return (
      `${index + 1}. ${sub.planName}\n` +
      `ID: ${id}\n` +
      `Status: ${active ? "Active" : "Expired"}\n` +
      `Expires: ${formatDate(sub.expiresAt)}`
    );
  });

  await ctx.reply(`👥 SUBSCRIPTIONS\n\n${list.join("\n\n")}`);
});

// ========================================
// PAYSTACK WEBHOOK
// ========================================
app.post(
  "/paystack/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const signature = req.headers["x-paystack-signature"];

      if (!signature || !Buffer.isBuffer(req.body)) {
        return res.status(400).send("Invalid webhook request.");
      }

      const hash = crypto
        .createHmac("sha512", PAYSTACK_SECRET_KEY)
        .update(req.body)
        .digest("hex");

      const received = Buffer.from(signature, "hex");
      const expected = Buffer.from(hash, "hex");

      if (
        received.length !== expected.length ||
        !crypto.timingSafeEqual(received, expected)
      ) {
        console.log("❌ Invalid Paystack webhook signature");
        return res.sendStatus(401);
      }

      const event = JSON.parse(req.body.toString("utf8"));

      console.log("\n==============================");
      console.log("📡 PAYSTACK WEBHOOK");
      console.log("==============================");
      console.log("Event:", event.event);
      console.log("Reference:", event.data?.reference);
      console.log("Status:", event.data?.status);

      if (event.event === "charge.success") {
        await handlePaystackSuccess(event.data);
      }

      return res.sendStatus(200);
    } catch (error) {
      console.error("❌ WEBHOOK ERROR:", error.message);
      return res.sendStatus(500);
    }
  }
);

// ========================================
// HEALTH CHECK + START
// ========================================
app.get("/", (req, res) => {
  res.send("BRLU Premium Bot is running.");
});

app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});

bot.launch()
  .then(() => console.log("🤖 BRLU Premium Bot started successfully."))
  .catch((error) => console.error("❌ Bot failed to start:", error.message));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

require("dotenv").config();
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

// ─── Clients ────────────────────────────────────────────
const app = express();
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ─── Middleware ──────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Health Check ────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    app: "Fīdel",
    message: "AI Customer Win-Back System is running.",
  });
});

// ─── Whatsapp Webhook Verification ───────────────────────
//Twilio calls this once to verify your server is real
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const from = req.body.From?.replace("whatsapp:", "");
    const text = req.body.Body?.trim().toLowerCase();
    if (!from || !text) return;
    console.log(`📩 Message from ${from}: ${text}`);
    await handleMessage(from, text);
  } catch (err) {
    console.error("Webhook error:", err.message);
  }
});
// ─── WhatsApp Webhook Receiver ───────────────────────────
// Meta sends all incoming messages here
app.post("/webhook", async (req, res) => {
  // Always acknowledge immediately — Meta requires this
  res.sendStatus(200);

  try {
    const body = req.body;

    // Ignore non-WhatsApp events
    if (body.object !== "whatsapp_business_account") return;

    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messages = value?.messages;

    if (!messages || messages.length === 0) return;

    const msg = messages[0];
    const from = msg.from;           // sender's phone number
    const text = msg.text?.body?.trim().toLowerCase();

    if (!text) return;

    console.log(`📩 Message from ${from}: ${text}`);

    // ── Route incoming message ──
    await handleMessage(from, text);

  } catch (err) {
    console.error("Webhook error:", err.message);
  }
});

// ─── Message Router ───────────────────────────────────────
async function handleMessage(phone, text) {
  // Check if business owner already exists
  const { data: business } = await supabase
    .from("businesses")
    .select("*")
    .eq("whatsapp_number", phone)
    .single();

  if (!business) {
    // New owner — start registration
    await handleRegistration(phone, text);
  } else {
    // Existing owner — handle commands
    await handleCommands(phone, text, business);
  }
}

// ─── Registration Flow ────────────────────────────────────
async function handleRegistration(phone, text) {
  // Check if they're mid-registration (session exists)
  const { data: session } = await supabase
    .from("sessions")
    .select("*")
    .eq("phone_number", phone)
    .single();

  if (!session) {
    // First message ever — welcome them
    await supabase.from("sessions").insert({
      phone_number: phone,
      state: "awaiting_business_name",
      temp_data: {},
    });

    await sendMessage(
      phone,
      `Welcome to *Retain* 👋\n\nI help businesses automatically win back lost customers via WhatsApp.\n\nTo get started, what is your *business name*?`
    );
    return;
  }

  if (session.state === "awaiting_business_name") {
    // Save business name, ask for category
    await supabase
      .from("sessions")
      .update({
        state: "awaiting_category",
        temp_data: { business_name: text },
      })
      .eq("phone_number", phone);

    await sendMessage(
      phone,
      `Great! *${text}* is set ✅\n\nWhat type of business is it?\n\nReply with a number:\n1️⃣ Salon / Beauty\n2️⃣ Pharmacy / Clinic\n3️⃣ Restaurant / Food\n4️⃣ Supermarket / Shop\n5️⃣ Other`
    );
    return;
  }

  if (session.state === "awaiting_category") {
    const categories = {
      "1": "Salon / Beauty",
      "2": "Pharmacy / Clinic",
      "3": "Restaurant / Food",
      "4": "Supermarket / Shop",
      "5": "Other",
    };
    const category = categories[text] || "Other";
    const { business_name } = session.temp_data;

    // Create the business record
    await supabase.from("businesses").insert({
      whatsapp_number: phone,
      name: business_name,
      category,
      inactivity_threshold_days: 21,
      is_active: true,
    });

    // Create a user record linked to this business
    await supabase.from("users").insert({
      email: `${phone}@retain.app`,
      full_name: business_name,
    });

    // Clear session
    await supabase
      .from("sessions")
      .delete()
      .eq("phone_number", phone);

    await sendMessage(
      phone,
      `🎉 *${business_name}* is now live on Retain!\n\n` +
      `Here's what I can do for you:\n\n` +
      `📌 *[Name] visited* → Log a customer visit\n` +
      `📊 *Summary* → See today's activity\n` +
      `❓ *Help* → See all commands\n\n` +
      `Start by logging a visit. Example:\n👉 Type *Sarah visited*`
    );
    return;
  }
}

// ─── Command Handler ──────────────────────────────────────
async function handleCommands(phone, text, business) {
  // Command: "[name] visited"
  if (text.endsWith("visited")) {
    const customerName = text.replace("visited", "").trim();

    if (!customerName) {
      await sendMessage(phone, `Please include the customer name.\nExample: *Sarah visited*`);
      return;
    }

    await logVisit(phone, customerName, business);
    return;
  }

  // Command: "summary"
  if (text === "summary") {
    await sendSummary(phone, business);
    return;
  }

  // Command: "help"
  if (text === "help") {
    await sendMessage(
      phone,
      `*Retain Commands* 📋\n\n` +
      `*[Name] visited* — Log a customer visit\nExample: Sarah visited\n\n` +
      `*Summary* — See today's visit count\n\n` +
      `*Help* — Show this menu`
    );
    return;
  }

  // Unknown command
  await sendMessage(
    phone,
    `I didn't understand that. Type *Help* to see available commands.`
  );
}

// ─── Log a Customer Visit ─────────────────────────────────
async function logVisit(phone, customerName, business) {
  const now = new Date().toISOString();

  // Check if customer already exists for this business
  const { data: existing } = await supabase
    .from("customers")
    .select("*")
    .eq("business_id", business.id)
    .ilike("name", customerName)
    .single();

  if (existing) {
    // Update last visit
    await supabase
      .from("customers")
      .update({ last_purchase_at: now, status: "active" })
      .eq("id", existing.id);

    await sendMessage(
      phone,
      `✅ Visit logged!\n\n` +
      `👤 *${existing.name}*\n` +
      `🕐 ${new Date().toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit" })}\n` +
      `📅 Last seen before today: ${existing.last_purchase_at
        ? new Date(existing.last_purchase_at).toLocaleDateString("en-NG")
        : "First visit"}`
    );
  } else {
    // New customer — add them
    await supabase.from("customers").insert({
      business_id: business.id,
      name: customerName,
      phone_number: "unknown",
      last_purchase_at: now,
      status: "active",
    });

    await sendMessage(
      phone,
      `✅ *${customerName}* added as a new customer and visit logged!\n\n` +
      `Retain will automatically reach out if they go silent for *${business.inactivity_threshold_days} days*. 🤖`
    );
  }
}

// ─── Daily Summary ────────────────────────────────────────
async function sendSummary(phone, business) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const { data: visits, error } = await supabase
    .from("customers")
    .select("name, last_purchase_at")
    .eq("business_id", business.id)
    .gte("last_purchase_at", today.toISOString());

  if (error || !visits || visits.length === 0) {
    await sendMessage(phone, `📊 No visits logged today yet.\n\nLog one with: *[Name] visited*`);
    return;
  }

  const list = visits
    .map((v, i) => `${i + 1}. ${v.name}`)
    .join("\n");

  await sendMessage(
    phone,
    `📊 *Today's Visits — ${business.name}*\n\n${list}\n\n` +
    `──────────────\n` +
    `Total: *${visits.length} customer${visits.length > 1 ? "s" : ""}* visited today`
  );
}

// ─── Send WhatsApp Message ────────────────────────────────
async function sendMessage(to, message) {
  const twilio = require("twilio");
  const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

  try {
    await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: `whatsapp:${to}`,
      body: message,
    });
  } catch (err) {
    console.error("Failed to send message:", err.message);
  }
}
// ─── Start Server ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Retain server running on port ${PORT}`);
});
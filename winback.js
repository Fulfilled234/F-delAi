require("dotenv").config();
const twilio = require("twilio");
const { createClient } = require("@supabase/supabase-js");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function runWinBack() {
  console.log("🤖 Win-back job started...");

  // Get all active businesses
  const { data: businesses, error } = await supabase
    .from("businesses")
    .select("*")
    .eq("is_active", true);

  if (error || !businesses?.length) {
    console.log("No active businesses found.");
    return;
  }

  for (const business of businesses) {
    const thresholdDate = new Date();
    thresholdDate.setDate(thresholdDate.getDate() - business.inactivity_threshold_days);

    // Find lost customers — inactive beyond threshold
    const { data: lostCustomers } = await supabase
      .from("customers")
      .select("*")
      .eq("business_id", business.id)
      .eq("status", "active")
      .lt("last_purchase_at", thresholdDate.toISOString());

    if (!lostCustomers?.length) {
      console.log(`✅ No lost customers for ${business.name}`);
      continue;
    }

    console.log(`📋 ${lostCustomers.length} lost customers for ${business.name}`);

    for (const customer of lostCustomers) {
      try {
        // Skip if we already sent a win-back message in the last 7 days
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const { data: recentMessage } = await supabase
          .from("messages")
          .select("id")
          .eq("customer_id", customer.id)
          .gte("sent_at", sevenDaysAgo.toISOString())
          .single();

        if (recentMessage) {
          console.log(`⏭️ Already messaged ${customer.name} recently`);
          continue;
        }

        // Generate message with Gemini
        const message = await generateWinBackMessage(customer, business);
        if (!message) continue;

        // Send via Twilio (only if customer has a real phone number)
        if (customer.phone_number && customer.phone_number !== "unknown") {
          await twilioClient.messages.create({
            from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
            to: `whatsapp:${customer.phone_number}`,
            body: message,
          });
          console.log(`✅ Win-back sent to ${customer.name}`);
        } else {
          console.log(`⚠️ No phone for ${customer.name} — message generated but not sent`);
        }

        // Log to messages table
        await supabase.from("messages").insert({
          customer_id: customer.id,
          business_id: business.id,
          content: message,
          sent_at: new Date().toISOString(),
          customer_returned: false,
        });

        // Mark customer as lost
        await supabase
          .from("customers")
          .update({ status: "lost" })
          .eq("id", customer.id);

      } catch (err) {
        console.error(`❌ Error processing ${customer.name}:`, err.message);
      }
    }
  }

  console.log("✅ Win-back job complete.");
}

async function generateWinBackMessage(customer, business) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const daysSince = Math.floor(
      (new Date() - new Date(customer.last_purchase_at)) / (1000 * 60 * 60 * 24)
    );

    const prompt =
      `You are writing a WhatsApp win-back message for a Nigerian business.\n\n` +
      `Business: ${business.name} (${business.category})\n` +
      `Customer name: ${customer.name}\n` +
      `Days since last visit: ${daysSince}\n\n` +
      `Write a warm, friendly, personalized WhatsApp message to win this customer back.\n` +
      `- Keep it under 100 words\n` +
      `- Sound human, not robotic\n` +
      `- Include a gentle call to action\n` +
      `- Use Nigerian-friendly tone\n` +
      `- No markdown, plain text only\n` +
      `- End with the business name`;

    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch (err) {
    console.error("Gemini error:", err.message);
    return null;
  }
}

// Export for Vercel cron
module.exports = async (req, res) => {
  await runWinBack();
  res.status(200).json({ success: true });
};

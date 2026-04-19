/**
 * packageService.js  v1.4.39
 *
 * CORRECT Sellauth Checkout API (from official docs):
 *   POST /v1/shops/{shopId}/checkout
 *   Body: { cart: [{ productId, variantId, quantity }], affiliate: "<channelId>" }
 *   Response: { success: true, invoice_id: 632, invoice_url: "https://shop/checkout/..." }
 *
 * NOTE: Requires Sellauth Business Plan subscription
 * channelId tracked via: affiliate field (≤16 chars) + our purchase_log table
 *
 * Webhook: POST to our endpoint with { event: "NOTIFICATION.SHOP_INVOICE_CREATED", data: { invoice_id } }
 * We look up invoice_id in channel_purchases → activate credits
 */
const axios    = require("axios");
const supabase = require("../config/supabase");
const logger   = require("../utils/logger");

const SELLAUTH_API = "https://api.sellauth.com/v1";

function _saClient(apiKey) {
  return axios.create({
    baseURL: SELLAUTH_API, timeout: 15000,
    headers: {
      Authorization:  `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept:         "application/json"
    }
  });
}

async function _loadCreds() {
  let apiKey = null, shopId = null, shopUrl = null;
  try {
    const r = await supabase.from("settings")
      .select("sellauth_api_key, sellauth_shop_id, sellauth_shop_url")
      .single();
    if (r.data) {
      apiKey  = r.data.sellauth_api_key  || null;
      shopId  = r.data.sellauth_shop_id  || null;
      shopUrl = r.data.sellauth_shop_url || null;
    }
  } catch (_) {}
  apiKey  = apiKey  || process.env.SELLAUTH_API_KEY  || null;
  shopId  = shopId  || process.env.SELLAUTH_SHOP_ID  || null;
  shopUrl = shopUrl || process.env.SELLAUTH_SHOP_URL || null;
  return { apiKey, shopId, shopUrl };
}

async function _createCheckoutSession(productId, variantId, channelId, creds) {
  const { apiKey, shopId } = creds;

  if (!apiKey)  throw new Error("SELLAUTH_API_KEY fehlt in Render Env oder Dashboard-Einstellungen.");
  if (!shopId)  throw new Error("SELLAUTH_SHOP_ID fehlt in Render Env oder Dashboard-Einstellungen.");

  const pId = parseInt(String(productId), 10);
  const vId = parseInt(String(variantId), 10);
  if (isNaN(pId)) throw new Error(`Ungültige Product-ID: "${productId}"`);
  if (isNaN(vId)) throw new Error(`Ungültige Variant-ID: "${variantId}"`);

  // affiliate: encode channelId (max 16 chars per Sellauth docs)
  // channelId like -1003617992232 = 14 chars ✓
  const affiliateStr = String(channelId).substring(0, 16);

  const body = {
    cart: [{
      productId: pId,
      variantId: vId,
      quantity: 1
    }],
    affiliate: affiliateStr
  };

  logger.info(`[Packages] POST /shops/${shopId}/checkout cart=[${pId}/${vId}] affiliate="${affiliateStr}"`);

  let resp;
  try {
    resp = await _saClient(apiKey).post(`/shops/${shopId}/checkout`, body);
  } catch (axErr) {
    const status = axErr.response?.status;
    const data   = JSON.stringify(axErr.response?.data || axErr.message);
    logger.error(`[Packages] Checkout ${status}: ${data}`);

    if (status === 403) {
      throw new Error("Sellauth Business Plan erforderlich für Checkout-API. Bitte Plan upgraden auf sellauth.com.");
    }
    if (status === 422) {
      throw new Error(`Sellauth Validierungsfehler: ${data}`);
    }
    throw new Error(`Sellauth ${status || "Netzwerkfehler"}: ${data}`);
  }

  const result = resp.data;
  logger.info(`[Packages] ✅ Checkout created: invoice_id=${result.invoice_id} url=${result.invoice_url}`);

  if (!result.invoice_url) {
    throw new Error(`Sellauth returned no invoice_url: ${JSON.stringify(result).substring(0, 200)}`);
  }

  return {
    checkoutUrl: result.invoice_url,
    invoiceId:   String(result.invoice_id),
    url:         result.url || null  // gateway-specific (e.g. Stripe URL)
  };
}

const packageService = {

  async generateCheckoutUrl(pkg, channelId) {
    if (!pkg.sellauth_variant_id) throw new Error(`Paket "${pkg.name}": Variant-ID fehlt.`);
    if (!pkg.sellauth_product_id) throw new Error(`Paket "${pkg.name}": Product-ID fehlt.`);
    const creds = await _loadCreds();
    const result = await _createCheckoutSession(
      pkg.sellauth_product_id, pkg.sellauth_variant_id, channelId, creds
    );
    try {
      await supabase.from("channel_purchases").insert([{
        channel_id:          String(channelId),
        package_id:          pkg.id,
        sellauth_invoice_id: result.invoiceId,
        credits_added:       pkg.credits,
        expires_at:          new Date(Date.now() + (pkg.duration_days || 30) * 86400000).toISOString(),
        status:              "pending",
        meta:                { package_name: pkg.name, price_eur: pkg.price_eur }
      }]);
    } catch (e) { logger.warn("[Packages] purchase log:", e.message); }
    return result;
  },

  async generateRefillUrl(refill, channelId) {
    if (!refill.sellauth_variant_id) throw new Error(`Refill "${refill.name}": Variant-ID fehlt.`);
    if (!refill.sellauth_product_id) throw new Error(`Refill "${refill.name}": Product-ID fehlt.`);
    const creds = await _loadCreds();
    const result = await _createCheckoutSession(
      refill.sellauth_product_id, refill.sellauth_variant_id, channelId, creds
    );
    try {
      await supabase.from("channel_purchases").insert([{
        channel_id:          String(channelId),
        package_id:          null,
        sellauth_invoice_id: result.invoiceId,
        credits_added:       refill.credits,
        expires_at:          new Date(Date.now() + 365 * 86400000).toISOString(),
        status:              "pending",
        meta:                { type: "refill", refill_name: refill.name, price_eur: refill.price_eur }
      }]);
    } catch (e) { logger.warn("[Packages] refill log:", e.message); }
    return result;
  },

  // ── Webhook handler ────────────────────────────────────────────────────────
  // Sellauth sends: { event: "NOTIFICATION.SHOP_INVOICE_CREATED", data: { invoice_id: 1218 } }
  // After payment:  { event: "NOTIFICATION.SHOP_INVOICE_COMPLETED", data: { invoice_id: 1218 } }
  async handleWebhook(payload) {
    const event     = payload.event || payload.type || "";
    const invoiceId = String(payload.data?.invoice_id || payload.data?.id || payload.invoice?.id || payload.id || "");

    // Only process completed payment events
    const isCompleted =
      event.includes("COMPLETED") ||
      event === "invoice.completed" ||
      event === "order.completed" ||
      event === "completed" ||
      payload.data?.status === "completed" ||
      payload.invoice?.status === "completed" ||
      payload.status === "completed";

    if (!isCompleted) {
      logger.info(`[Packages] Webhook event "${event}" not a completion — skipping`);
      return { handled: false };
    }

    if (!invoiceId) {
      logger.warn("[Packages] Webhook: no invoice_id found in payload", JSON.stringify(payload).substring(0, 200));
      return { handled: false };
    }

    // Find our pending purchase by invoice_id (numeric or string)
    let purchase = null;
    try {
      const r = await supabase.from("channel_purchases")
        .select("*, channel_packages(*)")
        .eq("sellauth_invoice_id", invoiceId).maybeSingle();
      purchase = r.data;
    } catch (_) {}

    // Fallback: try affiliate field (channelId stored there)
    let channelId = purchase?.channel_id;
    if (!channelId) {
      // Try to get channelId from invoice affiliate field
      const affiliateInPayload = payload.data?.affiliate || payload.affiliate || null;
      if (affiliateInPayload) channelId = affiliateInPayload;
    }

    const credits = purchase?.credits_added || 0;

    if (!channelId || !credits) {
      logger.warn("[Packages] Webhook: cannot resolve channelId or credits", { invoiceId, channelId, credits });
      return { handled: false };
    }

    const isRefill = (purchase?.meta?.type === "refill");

    let ch = null;
    try {
      const r2 = await supabase.from("bot_channels")
        .select("token_used,token_limit,added_by_user_id,title,credits_expire_at")
        .eq("id", String(channelId)).maybeSingle();
      ch = r2.data;
    } catch (_) {}
    if (!ch) { logger.warn("[Packages] Channel not found:", channelId); return { handled: false }; }

    try {
      let finalExpiresAt = null;
      if (isRefill) {
        const newLimit = (ch.token_limit || 0) + credits;
        await supabase.from("bot_channels").update({
          token_limit: newLimit, token_budget_exhausted: false,
          ai_enabled: true, updated_at: new Date()
        }).eq("id", String(channelId));
        finalExpiresAt = ch.credits_expire_at;
        logger.info(`[Packages] Refill ✅ +${credits} → ${newLimit}`);
      } else {
        const days      = purchase?.channel_packages?.duration_days || 30;
        const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
        await supabase.from("bot_channels").update({
          token_limit: credits, token_used: 0,
          token_budget_exhausted: false, ai_enabled: true,
          credits_expire_at: expiresAt, updated_at: new Date()
        }).eq("id", String(channelId));
        finalExpiresAt = expiresAt;
        logger.info(`[Packages] Package ✅ ${credits} credits until ${expiresAt}`);
      }
      if (purchase?.id) {
        try { await supabase.from("channel_purchases").update({ status: "completed" }).eq("id", purchase.id); }
        catch (_) {}
      }
      return { handled: true, channelId, credits, isRefill, adminId: ch.added_by_user_id, title: ch.title, expiresAt: finalExpiresAt };
    } catch (e) {
      logger.error("[Packages] Booking error:", e.message);
      return { handled: false };
    }
  }
};

module.exports = packageService;

/**
 * packageService.js  v1.4.38
 *
 * Sellauth Invoice creation - correct body format:
 *   POST /shops/{shopId}/invoices
 *   Body: { items: [{ product_id: <int>, variant_id: <int>, quantity: 1 }] }
 *
 * Note: variant_id at root level returns 404 - must use items array
 */
const axios    = require("axios");
const supabase = require("../config/supabase");
const logger   = require("../utils/logger");

const SELLAUTH_API = "https://api.sellauth.com/v1";

function _saClient(apiKey) {
  return axios.create({
    baseURL: SELLAUTH_API, timeout: 20000,
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
  apiKey  = apiKey  || process.env.SELLAUTH_API_KEY   || null;
  shopId  = shopId  || process.env.SELLAUTH_SHOP_ID   || null;
  shopUrl = shopUrl || process.env.SELLAUTH_SHOP_URL  || null;
  return { apiKey, shopId, shopUrl };
}

async function _createInvoice(productId, variantId, channelId, label, creds) {
  const { apiKey, shopId, shopUrl } = creds;

  if (!apiKey)  throw new Error("Sellauth API-Key fehlt (Render Env: SELLAUTH_API_KEY).");
  if (!shopId)  throw new Error("Sellauth Shop-ID fehlt (Render Env: SELLAUTH_SHOP_ID).");
  if (!shopUrl) throw new Error("Sellauth Shop-URL fehlt (Render Env: SELLAUTH_SHOP_URL).");

  const vId = parseInt(String(variantId), 10);
  if (isNaN(vId)) throw new Error(`Ungültige Variant-ID: "${variantId}"`);

  // items[] format — this is the correct Sellauth API format
  const item = { variant_id: vId, quantity: 1 };
  if (productId) {
    const pId = parseInt(String(productId), 10);
    if (!isNaN(pId)) item.product_id = pId;
  }

  const body = {
    items: [item],
    // custom_fields supported on paid Sellauth plans; omit if causing issues
    ...(channelId ? {
      custom_fields: [
        { name: "channel_id", value: String(channelId) },
        { name: "label",      value: label || "credit" }
      ]
    } : {})
  };

  logger.info(`[Packages] Creating invoice items=[variant=${vId}] channel=${channelId} shop=${shopId}`);
  logger.info(`[Packages] POST /shops/${shopId}/invoices body: ${JSON.stringify(body)}`);

  let resp;
  try {
    resp = await _saClient(apiKey).post(`/shops/${shopId}/invoices`, body);
  } catch (axErr) {
    const status = axErr.response?.status;
    const data   = JSON.stringify(axErr.response?.data || axErr.message);
    logger.error(`[Packages] Sellauth ${status} error: ${data}`);

    // Retry without custom_fields (some Sellauth plans don't support them)
    if (status === 400 || status === 422) {
      logger.info("[Packages] Retrying without custom_fields...");
      const body2 = { items: [item] };
      try {
        resp = await _saClient(apiKey).post(`/shops/${shopId}/invoices`, body2);
      } catch (axErr2) {
        const d2 = JSON.stringify(axErr2.response?.data || axErr2.message);
        throw new Error(`Sellauth ${axErr2.response?.status || "network"}: ${d2}`);
      }
    } else {
      throw new Error(`Sellauth ${status}: ${data}`);
    }
  }

  const invoice = resp.data;
  if (!invoice?.unique_id) {
    logger.error("[Packages] No unique_id in response:", JSON.stringify(invoice).substring(0, 300));
    throw new Error(`Sellauth: keine unique_id in Antwort. ${JSON.stringify(invoice).substring(0, 200)}`);
  }

  const checkoutUrl = `${shopUrl.replace(/\/$/, "")}/checkout/${invoice.unique_id}`;
  logger.info(`[Packages] ✅ Invoice ${invoice.id} → ${checkoutUrl}`);

  // Store channel_id in purchase log even if Sellauth doesn't accept custom_fields
  return { checkoutUrl, invoiceId: String(invoice.id), uniqueId: invoice.unique_id };
}

const packageService = {

  async generateCheckoutUrl(pkg, channelId) {
    if (!pkg.sellauth_variant_id) {
      throw new Error(`Paket "${pkg.name}": keine Variant-ID hinterlegt.`);
    }
    const creds = await _loadCreds();
    const result = await _createInvoice(
      pkg.sellauth_product_id, pkg.sellauth_variant_id,
      channelId, `pkg_${pkg.id}`, creds
    );
    await supabase.from("channel_purchases").insert([{
      channel_id: String(channelId), package_id: pkg.id,
      sellauth_invoice_id: result.invoiceId, credits_added: pkg.credits,
      expires_at: new Date(Date.now() + (pkg.duration_days || 30) * 86400000).toISOString(),
      status: "pending", meta: { package_name: pkg.name, price_eur: pkg.price_eur }
    }]).catch(e => logger.warn("[Packages] log:", e.message));
    return result;
  },

  async generateRefillUrl(refill, channelId) {
    if (!refill.sellauth_variant_id) {
      throw new Error(`Refill "${refill.name}": keine Variant-ID hinterlegt.`);
    }
    const creds = await _loadCreds();
    const result = await _createInvoice(
      refill.sellauth_product_id, refill.sellauth_variant_id,
      channelId, `refill_${refill.id}`, creds
    );
    await supabase.from("channel_purchases").insert([{
      channel_id: String(channelId), package_id: null,
      sellauth_invoice_id: result.invoiceId, credits_added: refill.credits,
      expires_at: new Date(Date.now() + 365 * 86400000).toISOString(),
      status: "pending", meta: { type: "refill", refill_name: refill.name, price_eur: refill.price_eur }
    }]).catch(e => logger.warn("[Packages] refill log:", e.message));
    return result;
  },

  async handleWebhook(payload) {
    const event   = payload.event || payload.type || "";
    const invoice = payload.data  || payload.invoice || payload;
    const status  = invoice.status;

    if (!["invoice.completed","order.completed","completed"].includes(event) && status !== "completed") {
      logger.info(`[Packages] Webhook ignored: event="${event}" status="${status}"`);
      return { handled: false };
    }

    const invoiceId = String(invoice.id || "");
    if (!invoiceId) return { handled: false };

    // channelId: from custom_fields, or from purchase log
    const customFields = invoice.custom_fields || [];
    const channelId = customFields.find(f => f.name === "channel_id")?.value;
    const label     = customFields.find(f => f.name === "label")?.value || "";
    const isRefill  = label.startsWith("refill_");

    let purchase = null;
    try {
      const r = await supabase.from("channel_purchases")
        .select("*, channel_packages(*)")
        .eq("sellauth_invoice_id", invoiceId).maybeSingle();
      purchase = r.data;
    } catch (_) {}

    const finalChannelId = channelId || purchase?.channel_id;
    const credits        = purchase?.credits_added || 0;

    if (!finalChannelId || !credits) {
      logger.warn("[Packages] Webhook: missing channelId or credits", { invoiceId, finalChannelId, credits });
      return { handled: false };
    }

    let ch = null;
    try {
      const r2 = await supabase.from("bot_channels")
        .select("token_used,token_limit,added_by_user_id,title,credits_expire_at")
        .eq("id", String(finalChannelId)).maybeSingle();
      ch = r2.data;
    } catch (_) {}
    if (!ch) return { handled: false };

    try {
      if (isRefill) {
        const newLimit = (ch.token_limit || 0) + credits;
        await supabase.from("bot_channels").update({
          token_limit: newLimit, token_budget_exhausted: false,
          ai_enabled: true, updated_at: new Date()
        }).eq("id", String(finalChannelId));
        logger.info(`[Packages] Refill: +${credits} → total ${newLimit}`);
      } else {
        const days = purchase?.channel_packages?.duration_days || 30;
        const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
        await supabase.from("bot_channels").update({
          token_limit: credits, token_used: 0, token_budget_exhausted: false,
          ai_enabled: true, credits_expire_at: expiresAt, updated_at: new Date()
        }).eq("id", String(finalChannelId));
        logger.info(`[Packages] Package activated: ${credits} credits until ${expiresAt}`);
      }
      if (purchase?.id) {
        await supabase.from("channel_purchases")
          .update({ status: "completed" }).eq("id", purchase.id).catch(() => {});
      }
      return { handled: true, channelId: finalChannelId, credits, isRefill, adminId: ch.added_by_user_id, title: ch.title };
    } catch (e) {
      logger.error("[Packages] Booking error:", e.message);
      return { handled: false };
    }
  }
};

module.exports = packageService;

/**
 * packageService.js  v1.4.37
 *
 * Sellauth: POST /shops/{shopId}/invoices
 *   Body: { variant_id: <int>, quantity: 1, custom_fields: [...] }
 *   Response: { id, unique_id }
 *   Checkout: {shopUrl}/checkout/{unique_id}
 *
 * Credentials: settings table OR process.env fallback
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

// Load Sellauth credentials: settings table first, env fallback
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
  // Fall back to env vars (always set on Render)
  apiKey  = apiKey  || process.env.SELLAUTH_API_KEY   || null;
  shopId  = shopId  || process.env.SELLAUTH_SHOP_ID   || null;
  shopUrl = shopUrl || process.env.SELLAUTH_SHOP_URL  || null;
  return { apiKey, shopId, shopUrl };
}

async function _createInvoice(variantId, channelId, label, creds) {
  const { apiKey, shopId, shopUrl } = creds;

  if (!apiKey)  throw new Error("Sellauth API-Key fehlt. Bitte in Dashboard-Einstellungen oder als Render-Env-Var SELLAUTH_API_KEY eintragen.");
  if (!shopId)  throw new Error("Sellauth Shop-ID fehlt. Bitte in Dashboard-Einstellungen oder als Render-Env-Var SELLAUTH_SHOP_ID eintragen.");
  if (!shopUrl) throw new Error("Sellauth Shop-URL fehlt. Bitte als Render-Env-Var SELLAUTH_SHOP_URL eintragen.");

  // variant_id MUST be integer for Sellauth
  const vId = parseInt(String(variantId), 10);
  if (isNaN(vId)) throw new Error(`Ungültige Variant-ID: "${variantId}"`);

  const body = {
    variant_id:    vId,
    quantity:      1,
    custom_fields: [
      { name: "channel_id", value: String(channelId) },
      { name: "label",      value: label || "credit" }
    ]
  };

  logger.info(`[Packages] Creating invoice variant=${vId} channel=${channelId} shopId=${shopId}`);

  let resp;
  try {
    resp = await _saClient(apiKey).post(`/shops/${shopId}/invoices`, body);
  } catch (axErr) {
    const status = axErr.response?.status;
    const data   = axErr.response?.data;
    logger.error(`[Packages] Sellauth ${status || "network"} error:`, JSON.stringify(data || axErr.message));
    // Re-throw with readable message
    const msg = (typeof data === "object" ? JSON.stringify(data) : String(data || axErr.message));
    throw new Error(`Sellauth ${status}: ${msg}`);
  }

  const invoice = resp.data;
  if (!invoice?.unique_id) {
    logger.error("[Packages] Sellauth response missing unique_id:", JSON.stringify(invoice).substring(0, 300));
    throw new Error(`Sellauth-Antwort enthält keine unique_id: ${JSON.stringify(invoice).substring(0, 200)}`);
  }

  const checkoutUrl = `${shopUrl.replace(/\/$/, "")}/checkout/${invoice.unique_id}`;
  logger.info(`[Packages] ✅ Invoice ${invoice.id} → ${checkoutUrl}`);
  return { checkoutUrl, invoiceId: String(invoice.id), uniqueId: invoice.unique_id };
}

const packageService = {

  async generateCheckoutUrl(pkg, channelId) {
    if (!pkg.sellauth_variant_id) throw new Error(`Paket "${pkg.name}": keine Variant-ID hinterlegt.`);
    const creds = await _loadCreds();
    const result = await _createInvoice(pkg.sellauth_variant_id, channelId, `pkg_${pkg.id}`, creds);
    await supabase.from("channel_purchases").insert([{
      channel_id: String(channelId), package_id: pkg.id,
      sellauth_invoice_id: result.invoiceId, credits_added: pkg.credits,
      expires_at: new Date(Date.now() + (pkg.duration_days || 30) * 86400000).toISOString(),
      status: "pending", meta: { package_name: pkg.name, price_eur: pkg.price_eur }
    }]).catch(e => logger.warn("[Packages] log:", e.message));
    return result;
  },

  async generateRefillUrl(refill, channelId) {
    if (!refill.sellauth_variant_id) throw new Error(`Refill "${refill.name}": keine Variant-ID.`);
    const creds = await _loadCreds();
    const result = await _createInvoice(refill.sellauth_variant_id, channelId, `refill_${refill.id}`, creds);
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

    const customFields = invoice.custom_fields || [];
    const channelId = customFields.find(f => f.name === "channel_id")?.value;
    const label     = customFields.find(f => f.name === "label")?.value || "";
    const isRefill  = label.startsWith("refill_");

    let purchase = null;
    try {
      const r = await supabase.from("channel_purchases").select("*, channel_packages(*)").eq("sellauth_invoice_id", invoiceId).maybeSingle();
      purchase = r.data;
    } catch (_) {}

    const finalChannelId = channelId || purchase?.channel_id;
    const credits = purchase?.credits_added || 0;
    if (!finalChannelId || !credits) {
      logger.warn("[Packages] Webhook missing data:", { invoiceId, finalChannelId, credits });
      return { handled: false };
    }

    let ch = null;
    try {
      const r2 = await supabase.from("bot_channels").select("token_used,token_limit,added_by_user_id,title,credits_expire_at").eq("id", String(finalChannelId)).maybeSingle();
      ch = r2.data;
    } catch (_) {}
    if (!ch) return { handled: false };

    try {
      if (isRefill) {
        const newLimit = (ch.token_limit || 0) + credits;
        await supabase.from("bot_channels").update({ token_limit: newLimit, token_budget_exhausted: false, ai_enabled: true, updated_at: new Date() }).eq("id", String(finalChannelId));
      } else {
        const days = purchase?.channel_packages?.duration_days || 30;
        const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
        await supabase.from("bot_channels").update({ token_limit: credits, token_used: 0, token_budget_exhausted: false, ai_enabled: true, credits_expire_at: expiresAt, updated_at: new Date() }).eq("id", String(finalChannelId));
      }
      if (purchase?.id) await supabase.from("channel_purchases").update({ status: "completed" }).eq("id", purchase.id).catch(() => {});
      return { handled: true, channelId: finalChannelId, credits, isRefill, adminId: ch.added_by_user_id, title: ch.title };
    } catch (e) {
      logger.error("[Packages] Booking error:", e.message);
      return { handled: false };
    }
  }
};

module.exports = packageService;

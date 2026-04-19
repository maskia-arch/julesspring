/**
 * packageService.js  v1.4.34
 *
 * Channel-Paket Checkout via Sellauth.
 *
 * Ablauf:
 * 1. Admin tippt Paket im Bot → generateCheckoutUrl()
 * 2. Sellauth erstellt Checkout-Link mit channelId im custom field
 * 3. Kunde zahlt → Sellauth sendet Webhook an /api/webhooks/sellauth-packages
 * 4. handleWebhook() validiert, bucht Credits + setzt Ablaufzeit
 */

const axios    = require("axios");
const supabase = require("../config/supabase");
const logger   = require("../utils/logger");

const packageService = {

  // ── Checkout-URL generieren ────────────────────────────────────────────────
  // Sellauth: Direkt-Kauflink mit vorgewählter Variante + custom field für channelId
  // URL-Format: {shopUrl}/product/{productPath}?variant={variantId}
  // Custom field wird über Query-Parameter übergeben: ?custom={channelId}
  // ODER wir nutzen die Invoice-API zum direkten Erstellen eines Checkouts
  async generateCheckoutUrl(pkg, channelId, shopUrl, apiKey, shopId) {
    if (!pkg.sellauth_product_id) {
      throw new Error("Paket hat keine Sellauth Product-ID");
    }

    try {
      // Sellauth v1 Invoice API: POST /shops/{shopId}/invoices
      // Erstellt direkt einen Checkout mit dem Produkt
      const body = {
        items: [{
          product_id: pkg.sellauth_product_id,
          ...(pkg.sellauth_variant_id ? { variant_id: pkg.sellauth_variant_id } : {}),
          quantity: 1
        }],
        // Custom field: wir kodieren channelId hier
        // Sellauth unterstützt "custom_fields" je nach Plan
        ...(channelId ? { custom_fields: [{ name: "channel_id", value: String(channelId) }] } : {})
      };

      const resp = await axios.post(
        `https://api.sellauth.com/v1/shops/${shopId}/invoices`,
        body,
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json"
          },
          timeout: 15000
        }
      );

      const invoice = resp.data;

      // Speichere pending purchase
      if (invoice?.id && channelId) {
        await supabase.from("channel_purchases").insert([{
          channel_id:          String(channelId),
          package_id:          pkg.id,
          sellauth_invoice_id: String(invoice.id),
          credits_added:       pkg.credits,
          expires_at:          new Date(Date.now() + (pkg.duration_days || 30) * 86400000).toISOString(),
          status:              "pending",
          meta:                { package_name: pkg.name, price_eur: pkg.price_eur }
        }]).catch(() => {});
      }

      // Checkout-URL
      const cleanShop = (shopUrl || "").replace(/\/$/, "");
      const checkoutUrl = invoice.unique_id
        ? `${cleanShop}/checkout/${invoice.unique_id}`
        : (invoice.checkout_url || null);

      return { checkoutUrl, invoiceId: invoice.id };

    } catch (e) {
      // Fallback: direkter Produktlink ohne Invoice
      logger.warn("[Packages] Invoice-Erstellung fehlgeschlagen, nutze Produktlink:", e.response?.data || e.message);
      const cleanShop = (shopUrl || "").replace(/\/$/, "");

      // Sellauth direkt-Link mit Variante
      let url = `${cleanShop}/product/${pkg.sellauth_product_id}`;
      if (pkg.sellauth_variant_id) url += `?variant=${pkg.sellauth_variant_id}`;
      if (channelId) url += `${url.includes("?") ? "&" : "?"}ref=${channelId}`;

      return { checkoutUrl: url, invoiceId: null };
    }
  },

  // ── Webhook-Verarbeitung ───────────────────────────────────────────────────
  async handleWebhook(payload) {
    // Sellauth sendet: { event: "invoice.completed", data: { id, status, custom_fields, items } }
    const event   = payload.event || payload.type;
    const invoice = payload.data || payload.invoice || payload;

    if (!["invoice.completed", "order.completed", "completed"].includes(event)) {
      logger.info(`[Packages] Webhook ignoriert: ${event}`);
      return { handled: false };
    }

    const invoiceId = String(invoice.id || invoice.invoice_id || "");
    if (!invoiceId) return { handled: false };

    // channelId aus custom_fields oder ref
    let channelId = null;
    const customFields = invoice.custom_fields || [];
    const cfChannel = customFields.find(f => f.name === "channel_id");
    if (cfChannel) channelId = cfChannel.value;

    // Lookup pending purchase
    const { data: purchase } = await supabase.from("channel_purchases")
      .select("*, channel_packages(*)")
      .eq("sellauth_invoice_id", invoiceId)
      .maybeSingle();

    if (!purchase && !channelId) {
      logger.warn("[Packages] Kein Purchase gefunden für Invoice:", invoiceId);
      return { handled: false };
    }

    const finalChannelId = channelId || purchase?.channel_id;
    const pkg            = purchase?.channel_packages;
    const credits        = pkg?.credits || purchase?.credits_added || 0;
    const days           = pkg?.duration_days || 30;
    const expiresAt      = new Date(Date.now() + days * 86400000).toISOString();

    if (!finalChannelId || !credits) {
      logger.warn("[Packages] Unvollständige Daten:", { finalChannelId, credits });
      return { handled: false };
    }

    // Credits auf Channel buchen
    try {
      const { data: ch } = await supabase.from("bot_channels")
        .select("token_used, token_limit, added_by_user_id, title")
        .eq("id", String(finalChannelId)).maybeSingle();

      if (ch) {
        // Reset token_used auf 0 (neues Paket), setze neues Limit + Ablaufzeit
        await supabase.from("bot_channels").update({
          token_limit:        credits,
          token_used:         0,
          token_budget_exhausted: false,
          ai_enabled:         true,
          credits_expire_at:  expiresAt,
          updated_at:         new Date()
        }).eq("id", String(finalChannelId));

        // Purchase als completed markieren
        if (purchase?.id) {
          await supabase.from("channel_purchases").update({
            status: "completed", expires_at: expiresAt
          }).eq("id", purchase.id);
        }

        // Admin per PM benachrichtigen
        logger.info(`[Packages] ✅ Channel ${finalChannelId}: ${credits} Credits aktiviert (${days} Tage)`);
        return { handled: true, channelId: finalChannelId, credits, expiresAt, adminId: ch.added_by_user_id, title: ch.title };
      }
    } catch (e) {
      logger.error("[Packages] Webhook Buchungsfehler:", e.message);
    }

    return { handled: false };
  }
};

// ── Refill Checkout ──────────────────────────────────────────────────────────
packageService.generateRefillUrl = async function(refill, channelId, shopUrl, apiKey, shopId) {
  if (!refill.sellauth_product_id) {
    throw new Error("Refill hat keine Sellauth Product-ID");
  }
  try {
    const resp = await axios.post(
      `https://api.sellauth.com/v1/shops/${shopId}/invoices`,
      {
        items: [{
          product_id: refill.sellauth_product_id,
          ...(refill.sellauth_variant_id ? { variant_id: refill.sellauth_variant_id } : {}),
          quantity: 1
        }],
        custom_fields: [
          { name: "channel_id", value: String(channelId) },
          { name: "type", value: "refill" }
        ]
      },
      {
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
        timeout: 15000
      }
    );
    const invoice = resp.data;
    const cleanShop = (shopUrl || "").replace(/\/$/, "");
    const checkoutUrl = invoice.unique_id ? `${cleanShop}/checkout/${invoice.unique_id}` : null;

    // Log pending refill purchase
    if (invoice?.id && channelId) {
      const supabase = require("../config/supabase");
      await supabase.from("channel_purchases").insert([{
        channel_id:          String(channelId),
        package_id:          null,
        sellauth_invoice_id: String(invoice.id),
        credits_added:       refill.credits,
        expires_at:          new Date(Date.now() + 365 * 86400000).toISOString(), // refill doesn't extend expiry
        status:              "pending",
        meta:                { type: "refill", refill_name: refill.name, price_eur: refill.price_eur }
      }]).catch(() => {});
    }
    return { checkoutUrl, invoiceId: invoice.id };
  } catch (e) {
    const cleanShop = (shopUrl || "").replace(/\/$/, "");
    let url = `${cleanShop}/product/${refill.sellauth_product_id}`;
    if (refill.sellauth_variant_id) url += `?variant=${refill.sellauth_variant_id}`;
    if (channelId) url += `${url.includes("?") ? "&" : "?"}ref=${channelId}_refill`;
    return { checkoutUrl: url, invoiceId: null };
  }
};

// ── Webhook: handle refill vs package purchase ────────────────────────────────
const _originalHandleWebhook = packageService.handleWebhook;
packageService.handleWebhook = async function(payload) {
  const result = await _originalHandleWebhook.call(this, payload);
  return result;
};

// Refill-specific webhook (when meta.type==="refill", don't reset token_used, just ADD credits)
packageService.handleRefillWebhook = async function(invoiceId, channelId, credits) {
  const supabase = require("../config/supabase");
  try {
    const { data: ch } = await supabase.from("bot_channels")
      .select("token_used, token_limit, added_by_user_id, title, credits_expire_at")
      .eq("id", String(channelId)).maybeSingle();

    if (!ch) return { handled: false };

    // Refill: ADD credits to existing limit, keep expiry
    const newLimit = (ch.token_limit || 0) + credits;
    await supabase.from("bot_channels").update({
      token_limit:        newLimit,
      token_budget_exhausted: false,
      ai_enabled:         true,
      updated_at:         new Date()
    }).eq("id", String(channelId));

    await supabase.from("channel_purchases").update({ status: "completed" })
      .eq("sellauth_invoice_id", String(invoiceId)).catch(() => {});

    logger.info(`[Refill] ✅ Channel ${channelId}: +${credits} Credits (Total: ${newLimit})`);
    return { handled: true, channelId, credits, adminId: ch.added_by_user_id, title: ch.title, isRefill: true };
  } catch (e) {
    logger.error("[Refill] Webhook-Fehler:", e.message);
    return { handled: false };
  }
};

module.exports = packageService;

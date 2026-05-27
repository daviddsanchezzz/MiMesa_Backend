const Customer         = require('../models/Customer');
const MarketingCampaign = require('../models/MarketingCampaign');
const Business         = require('../models/Business');
const { Resend }       = require('resend');
const { sendTrackedEmail } = require('../services/emailDelivery');

const resend = new Resend(process.env.RESEND_API_KEY);

// ── GET /api/marketing/subscribers ───────────────────────────────────────────
exports.getSubscribers = async (req, res) => {
  try {
    const subscribers = await Customer.find({
      businessId:           req.businessId,
      marketingSubscribed:  true,
      marketingUnsubscribed: { $ne: true },
      email:                { $ne: '' },
    }).select('name email marketingSubscribedAt').sort({ marketingSubscribedAt: -1 });

    res.json(subscribers);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/marketing/campaigns ─────────────────────────────────────────────
exports.getCampaigns = async (req, res) => {
  try {
    const campaigns = await MarketingCampaign.find({ businessId: req.businessId })
      .sort({ sentAt: -1 }).limit(50);
    res.json(campaigns);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── POST /api/marketing/send ─────────────────────────────────────────────────
exports.sendCampaign = async (req, res) => {
  try {
    if (!process.env.RESEND_API_KEY || process.env.RESEND_API_KEY === 'your_resend_api_key_here') {
      return res.status(503).json({ message: 'Servicio de email no configurado' });
    }

    const { subject, body } = req.body;
    if (!subject?.trim() || !body?.trim()) {
      return res.status(400).json({ message: 'Asunto y cuerpo son obligatorios' });
    }

    // Rate limit: max 3 campaigns per 30 days
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentCount = await MarketingCampaign.countDocuments({
      businessId: req.businessId,
      sentAt: { $gte: since },
      status: 'sent',
    });
    if (recentCount >= 3) {
      return res.status(429).json({ message: 'Límite de 3 campañas por mes alcanzado' });
    }

    const business = await Business.findById(req.businessId).select('name brandColor');

    const subscribers = await Customer.find({
      businessId:            req.businessId,
      marketingSubscribed:   true,
      marketingUnsubscribed: { $ne: true },
      email:                 { $ne: '' },
    }).select('name email unsubscribeToken');

    if (subscribers.length === 0) {
      return res.status(400).json({ message: 'No hay suscriptores para este negocio' });
    }

    const accent = business?.brandColor || '#7C3AED';
    const landingUrl = process.env.LANDING_URL || 'https://vetrareserve.com';
    const frontendUrl = process.env.FRONTEND_URL || 'https://app.vetrareserve.com';
    const FROM = process.env.RESEND_FROM_SYSTEM || 'Reservas <noreply@resend.dev>';
    const fromMatch = FROM.match(/<(.+)>/);
    const fromEmail = fromMatch ? fromMatch[1] : FROM;
    const from = `${business?.name || 'Vetra'} <${fromEmail}>`;

    let sent = 0;
    const errors = [];

    for (const customer of subscribers) {
      const unsubUrl = `${frontendUrl}/public/unsubscribe?token=${customer.unsubscribeToken}`;

      const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">
        <tr><td style="background:${accent};padding:20px 32px;">
          <p style="margin:0;font-size:17px;font-weight:700;color:#fff;">${business?.name || ''}</p>
        </td></tr>
        <tr><td style="padding:28px 32px;">
          <p style="margin:0 0 8px;font-size:15px;color:#374151;">Hola, <strong>${customer.name}</strong></p>
          <div style="font-size:14px;color:#374151;line-height:1.7;">${body.replace(/\n/g, '<br>')}</div>
        </td></tr>
        <tr><td style="background:#f9fafb;padding:16px 32px 20px;border-top:1px solid #e5e7eb;">
          <p style="margin:0;font-size:11px;color:#9ca3af;text-align:center;line-height:1.7;">
            Recibiste este email porque reservaste en <strong>${business?.name || ''}</strong>
            y aceptaste recibir comunicaciones.<br>
            <a href="${unsubUrl}" style="color:#7C3AED;text-decoration:underline;">Darse de baja</a>
          </p>
          <p style="margin:10px 0 0;font-size:11px;color:#d1d5db;text-align:center;">
            Powered by <a href="${landingUrl}" style="color:#7C3AED;text-decoration:none;font-weight:600;">Vetra</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

      try {
        const result = await sendTrackedEmail({
          resend,
          source: 'marketing.campaign',
          metadata: {
            businessId: String(req.businessId),
            customerId: String(customer._id),
          },
          payload: { from, to: customer.email, subject, html },
        });
        if (result.error) errors.push(customer.email);
        else sent++;
      } catch {
        errors.push(customer.email);
      }
    }

    const campaign = await MarketingCampaign.create({
      businessId:     req.businessId,
      subject,
      body,
      recipientCount: sent,
      status:         'sent',
    });

    res.json({ sent, errors, campaignId: campaign._id });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/public/unsubscribe?token=xxx ────────────────────────────────────
exports.unsubscribe = async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ message: 'Token requerido' });

    const customer = await Customer.findOneAndUpdate(
      { unsubscribeToken: token },
      { $set: { marketingUnsubscribed: true, marketingUnsubscribedAt: new Date() } },
      { new: true }
    ).select('name');

    if (!customer) return res.status(404).json({ message: 'Token inválido o ya procesado' });

    res.json({ message: 'Baja procesada correctamente', name: customer.name });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const Customer         = require('../models/Customer');
const { escapeHtml } = require('../lib/escapeHtml');
const { acquireLock } = require('../lib/keyedLock');
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

    const business = await Business.findById(req.businessId).select('name brandColor email phone address logoUpdatedAt');

    const subscribers = await Customer.find({
      businessId:            req.businessId,
      marketingSubscribed:   true,
      marketingUnsubscribed: { $ne: true },
      email:                 { $ne: '' },
    }).select('name email unsubscribeToken');

    if (subscribers.length === 0) {
      return res.status(400).json({ message: 'No hay suscriptores para este negocio' });
    }

    // Rate limit: max 3 campaigns per 30 days. The check and the reservation of the slot
    // (a 'sending' record) happen under a lock so concurrent requests can't both pass it.
    let campaign;
    const release = await acquireLock(`campaign:${req.businessId}`);
    try {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const recentCount = await MarketingCampaign.countDocuments({
        businessId: req.businessId,
        sentAt: { $gte: since },
        status: { $in: ['sent', 'sending'] },
      });
      if (recentCount >= 3) {
        return res.status(429).json({ message: 'Límite de 3 campañas por mes alcanzado' });
      }
      campaign = await MarketingCampaign.create({
        businessId: req.businessId,
        subject,
        body,
        recipientCount: 0,
        status: 'sending',
      });
    } finally {
      release();
    }

    const accent = business?.brandColor || '#7C3AED';
    const landingUrl = process.env.LANDING_URL || 'https://vetrareserve.com';
    const frontendUrl = process.env.FRONTEND_URL || 'https://app.vetrareserve.com';
    const FROM = process.env.RESEND_FROM_SYSTEM || 'Reservas <noreply@resend.dev>';
    const fromMatch = FROM.match(/<(.+)>/);
    const fromEmail = fromMatch ? fromMatch[1] : FROM;
    const fromName = String(business?.name || 'Vetra').replace(/[<>"\r\n]/g, '').trim() || 'Vetra';
    const from = `${fromName} <${fromEmail}>`;

    let sent = 0;
    const errors = [];

    for (const customer of subscribers) {
      if (!customer.unsubscribeToken) {
        customer.unsubscribeToken = require('crypto').randomBytes(32).toString('hex');
        await customer.save();
      }
      const unsubUrl = `${frontendUrl}/public/unsubscribe?token=${customer.unsubscribeToken}`;

      const html = require('../services/accountEmails').buildCampaignEmail({
        business, logoUrl: require('../lib/images').businessLogoUrl(business),
        customerName: customer.name, subject, body, unsubUrl,
      });

      try {
        const result = await sendTrackedEmail({
          resend,
          source: 'marketing.campaign',
          metadata: {
            businessId: String(req.businessId),
            customerId: String(customer._id),
          },
          payload: { from, to: customer.email, replyTo: business?.email || undefined, subject, html },
        });
        if (result.error) errors.push(customer.email);
        else sent++;
      } catch {
        errors.push(customer.email);
      }
    }

    campaign.recipientCount = sent;
    campaign.status = sent > 0 ? 'sent' : 'failed';
    await campaign.save();

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

    if (typeof token !== 'string') return res.status(400).json({ message: 'Token requerido' });
    const customer = await Customer.findOne({ unsubscribeToken: token }).select('name marketingUnsubscribed').lean();
    if (!customer) return res.status(404).json({ message: 'Token inválido o ya procesado' });
    if (!customer.marketingUnsubscribed) {
      await Customer.updateOne({ _id: customer._id }, { $set: { marketingUnsubscribed: true, marketingUnsubscribedAt: new Date() } });
    }

    res.json({ message: 'Baja procesada correctamente', name: customer.name });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

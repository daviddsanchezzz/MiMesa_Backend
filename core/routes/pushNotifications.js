const express   = require('express');
const router    = express.Router();
const requireAuth = require('../middleware/requireAuth');
const PushSubscription = require('../models/PushSubscription');

router.get('/vapid-public-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || null });
});

router.post('/subscribe', requireAuth, async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return res.status(400).json({ message: 'Suscripción inválida' });
    }
    const userId     = req.user?.id;
    const businessId = req.businessId;
    if (!userId || !businessId) return res.status(403).json({ message: 'No autorizado' });

    await PushSubscription.findOneAndUpdate(
      { userId, businessId, 'subscription.endpoint': subscription.endpoint },
      { userId, businessId, subscription },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/unsubscribe', requireAuth, async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ message: 'Falta endpoint' });
    const userId     = req.user?.id;
    const businessId = req.businessId;
    await PushSubscription.deleteOne({ userId, businessId, 'subscription.endpoint': endpoint });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/status', requireAuth, async (req, res) => {
  try {
    const userId     = req.user?.id;
    const businessId = req.businessId;
    const count = await PushSubscription.countDocuments({ userId, businessId });
    res.json({ subscribed: count > 0 });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;

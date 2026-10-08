/**
 * The menu as the restaurant's website shows it: no session, read only, one language at a time.
 * Hidden dishes and categories, retired dishes and empty categories are left out.
 */
const mongoose = require('mongoose');
const Business = require('../../../core/models/Business');
const { canUseModule } = require('../../../core/lib/planCapabilities');
const { businessTimezone, dateInTimezone } = require('../../../core/lib/timezone');
const MenuSettings = require('../models/MenuSettings');
const MenuCategory = require('../models/MenuCategory');
const MenuItem = require('../models/MenuItem');
const DailyMenu = require('../models/DailyMenu');
const photos = require('../services/photoStorage');
const { DEFAULT_LANGUAGES } = require('../lib/constants');

/** The text in `lang`, else in the main language, else the first one written. */
const pick = (texts, lang, main) => (texts && (texts[lang] || texts[main] || Object.values(texts).find(Boolean))) || '';

/** Is the daily menu on sale on `date` (YYYY-MM-DD, the business's today)? */
function dailyIsOn(daily, date) {
  if (!daily?.active) return false;
  if (daily.from && date < daily.from) return false;
  if (daily.to && date > daily.to) return false;
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return !(daily.days || []).length || daily.days.includes(weekday);
}

exports.publicMenu = async (req, res) => {
  try {
    const { businessId } = req.params;
    if (!mongoose.isValidObjectId(businessId)) return res.status(404).json({ message: 'Negocio no encontrado' });
    const business = await Business.findById(businessId)
      .select('name phone address timezone plan subscriptionStatus legacyAccess paymentFailedAt trialEndsAt stripeSubscriptionId moduleOverrides businessType').lean();
    if (!business || !canUseModule(business, 'menu')) return res.status(404).json({ message: 'Negocio no encontrado' });

    const [settings, categories, items, daily] = await Promise.all([
      MenuSettings.findOne({ businessId }).lean(),
      MenuCategory.find({ businessId, hidden: { $ne: true } }).sort({ sortOrder: 1, createdAt: 1 }).lean(),
      MenuItem.find({ businessId, hidden: { $ne: true }, retired: { $ne: true } }).sort({ sortOrder: 1, createdAt: 1 }).lean(),
      DailyMenu.findOne({ businessId }).lean(),
    ]);
    const languages = settings?.languages?.length ? settings.languages : DEFAULT_LANGUAGES;
    const main = languages[0];
    const requested = String(req.query.lang || '').toLowerCase();
    const lang = languages.includes(requested) ? requested : main;
    const t = (texts) => pick(texts, lang, main);

    const extrasOf = (list, scope) => (list || []).map((x) => ({ name: t(x.name), price: x.price, allergens: x.allergens || [], scope }));
    const itemsOf = (cat, inherited) => items.filter((i) => String(i.categoryId) === String(cat._id)).map((i) => ({
      id: i._id, name: t(i.name), description: t(i.description), price: i.price,
      allergens: i.allergens, tags: i.tags, photo: i.photo?.url || null, soldOut: !!i.soldOut,
      // The dish's own extras, then its category's and, in a subcategory, the parent's (masa sin gluten +5 EUR for every pizza)
      extras: [...extrasOf(i.extras, 'dish'), ...extrasOf(cat.extras, 'category'), ...inherited],
    }));
    const out = categories.filter((c) => !c.parentId).map((c) => {
      const parentExtras = extrasOf(c.extras, 'category');
      const subcategories = categories.filter((s2) => String(s2.parentId) === String(c._id)).map((s2) => ({
        id: s2._id, name: t(s2.name), extras: extrasOf(s2.extras, 'category'), items: itemsOf(s2, parentExtras),
      })).filter((s2) => s2.items.length);
      return { id: c._id, name: t(c.name), extras: parentExtras, items: itemsOf(c, []), subcategories };
    }).filter((c) => c.items.length || c.subcategories.length);

    const today = dateInTimezone(new Date(), businessTimezone(business));
    const dailyOut = dailyIsOn(daily, today) ? {
      title: t(daily.title), includes: t(daily.includes), price: daily.price,
      courses: daily.courses.map((c) => ({ name: t(c.name), options: c.options.map((o) => ({ name: t(o.name), allergens: o.allergens })) })).filter((c) => c.options.length),
    } : null;

    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      business: { name: business.name, phone: business.phone || '', address: business.address || '' },
      language: lang, languages, currency: 'EUR', categories: out, daily: dailyOut,
    });
  } catch (err) {
    console.error('[menu] public', err);
    res.status(500).json({ message: 'No se ha podido cargar la carta' });
  }
};

// Development only: with the local provider the photos are served from disk (in production they are public in Supabase)
exports.publicPhoto = async (req, res) => {
  try {
    const found = await photos.open(`${req.params.businessId}/${req.params.file}`);
    if (!found) return res.status(404).end();
    res.set('Content-Type', `image/${found.ext === 'jpg' ? 'jpeg' : found.ext}`);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    found.stream.on('error', () => res.end());
    found.stream.pipe(res);
  } catch {
    res.status(404).end();
  }
};

exports.dailyIsOn = dailyIsOn;
exports.pick = pick;

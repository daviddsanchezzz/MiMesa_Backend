const Customer = require('../models/Customer');
const Reservation = require('../models/Reservation');
const { getPhoneMatchCandidates, toStoredNormalizedPhone } = require('../lib/phoneMatching');

async function findCustomerByEmailOrPhone({ businessId, email, phone, excludeId = null }) {
  const trimmedEmail = String(email || '').trim().toLowerCase();
  const trimmedPhone = String(phone || '').trim();
  const phoneCandidates = getPhoneMatchCandidates(trimmedPhone);

  const base = { businessId };
  if (excludeId) base._id = { $ne: excludeId };

  if (trimmedEmail) {
    const byEmail = await Customer.findOne({ ...base, email: trimmedEmail }).sort({ createdAt: 1 });
    if (byEmail) return byEmail;
  }

  if (phoneCandidates.length > 0) {
    const byPhone = await Customer.findOne({
      ...base,
      $or: [
        { normalizedPhone: { $in: phoneCandidates } },
        { phone: { $in: [trimmedPhone, ...phoneCandidates] } },
      ],
    }).sort({ createdAt: 1 });
    if (byPhone) return byPhone;
  }

  return null;
}

exports.getCustomers = async (req, res) => {
  try {
    const customers = await Customer.find({ businessId: req.businessId }).sort('-createdAt');
    res.json(customers);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.createCustomer = async (req, res) => {
  try {
    const { name, phone, email, notes, vip } = req.body;
    const safeName = String(name || '').trim();
    if (!safeName) return res.status(400).json({ message: 'El nombre es obligatorio' });

    const phoneStr = String(phone || '').trim();
    const emailStr = String(email || '').trim().toLowerCase();

    const existing = await findCustomerByEmailOrPhone({
      businessId: req.businessId,
      email: emailStr,
      phone: phoneStr,
    });

    if (existing) {
      const update = {};
      if (safeName && existing.name !== safeName) update.name = safeName;
      if (phoneStr && existing.phone !== phoneStr) update.phone = phoneStr;
      if (emailStr && existing.email !== emailStr) update.email = emailStr;
      if (phoneStr) update.normalizedPhone = toStoredNormalizedPhone(phoneStr);
      if (notes !== undefined) update.notes = notes || '';
      if (vip !== undefined) update.vip = Boolean(vip);

      if (Object.keys(update).length > 0) {
        const merged = await Customer.findOneAndUpdate(
          { _id: existing._id, businessId: req.businessId },
          { $set: update },
          { new: true }
        );
        return res.status(200).json({ ...merged.toObject(), merged: true });
      }
      return res.status(200).json({ ...existing.toObject(), merged: true });
    }

    const customer = await Customer.create({
      businessId: req.businessId,
      name: safeName,
      phone: phoneStr,
      normalizedPhone: toStoredNormalizedPhone(phoneStr),
      email: emailStr,
      notes: notes || '',
      vip: Boolean(vip),
    });
    res.status(201).json(customer);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updateCustomer = async (req, res) => {
  try {
    const payload = { ...req.body };
    if (payload.phone !== undefined) {
      const phoneStr = String(payload.phone || '').trim();
      payload.phone = phoneStr;
      payload.normalizedPhone = toStoredNormalizedPhone(phoneStr);
    }
    if (payload.email !== undefined) {
      payload.email = String(payload.email || '').trim().toLowerCase();
    }

    const duplicate = await findCustomerByEmailOrPhone({
      businessId: req.businessId,
      email: payload.email,
      phone: payload.phone,
      excludeId: req.params.id,
    });
    if (duplicate) {
      return res.status(409).json({
        message: 'Ya existe un cliente con ese telefono o email',
        duplicateCustomerId: duplicate._id,
      });
    }

    const customer = await Customer.findOneAndUpdate(
      { _id: req.params.id, businessId: req.businessId },
      payload,
      { new: true }
    );
    if (!customer) return res.status(404).json({ message: 'Customer not found' });
    res.json(customer);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getCustomerDetail = async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!customer) return res.status(404).json({ message: 'Customer not found' });

    const reservations = await Reservation.find({
      businessId: req.businessId,
      customerId: customer._id,
    })
      .select('date time people status notes roomId tableId tableIds createdAt')
      .populate({ path: 'roomId', select: 'name' })
      .populate({ path: 'tableId', select: 'name roomId', populate: { path: 'roomId', select: 'name' } })
      .populate({ path: 'tableIds', select: 'name roomId', populate: { path: 'roomId', select: 'name' } })
      .sort({ date: -1, time: -1 });

    const summary = {
      totalReservations: reservations.length,
      confirmed: reservations.filter((r) => r.status === 'confirmed').length,
      seated: reservations.filter((r) => r.status === 'seated').length,
      cancelled: reservations.filter((r) => r.status === 'cancelled').length,
      noShow: reservations.filter((r) => r.status === 'no_show').length,
      pending: reservations.filter((r) => r.status === 'pending').length,
      lastReservationDate: reservations[0]?.date || null,
    };

    res.json({
      customer,
      summary,
      reservations,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

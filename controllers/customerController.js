const Customer = require('../models/Customer');
const Reservation = require('../models/Reservation');

function normalizePhone(raw) {
  if (!raw) return '';
  return String(raw).replace(/\D/g, '');
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
    const phoneStr = String(phone || '').trim();
    const customer = await Customer.create({
      businessId: req.businessId,
      name,
      phone: phoneStr,
      normalizedPhone: normalizePhone(phoneStr),
      email: String(email || '').trim().toLowerCase(),
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
      payload.normalizedPhone = normalizePhone(phoneStr);
    }
    if (payload.email !== undefined) {
      payload.email = String(payload.email || '').trim().toLowerCase();
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

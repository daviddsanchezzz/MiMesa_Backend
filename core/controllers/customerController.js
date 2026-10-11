const Customer = require('../models/Customer');
const { pickFields } = require('../lib/pickFields');
const { optIn, optOut } = require('../lib/customerMarketing');
const Reservation = require('../../verticals/restaurant/models/Reservation');
const { upcomingFor, exportFor, eraseFor } = require('../lib/customerData');
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

// Staff (not owner/manager) get what they need to book someone, not the notes or history.
const STAFF_CUSTOMER_FIELDS = '_id name phone email vip';

exports.getCustomers = async (req, res) => {
  try {
    const manager = ['owner', 'manager'].includes(req.memberRole) || req.isDev;
    const q = Customer.find({ businessId: req.businessId }).sort('-createdAt');
    if (!manager) q.select(STAFF_CUSTOMER_FIELDS);
    res.json(await q);
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
    const payload = pickFields(req.body, ['name', 'phone', 'email', 'notes', 'vip']);
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
        message: 'Ya existe un cliente con ese teléfono o email',
        duplicateCustomerId: duplicate._id,
      });
    }

    const customer = await Customer.findOneAndUpdate(
      { _id: req.params.id, businessId: req.businessId },
      payload,
      { new: true }
    );
    if (!customer) return res.status(404).json({ message: 'Customer not found' });
    // The team records that the customer agreed (or does not want) emails with offers
    if (typeof req.body?.marketingSubscribed === 'boolean') {
      if (req.body.marketingSubscribed) {
        if (!customer.email) return res.status(400).json({ message: 'Para recibir comunicaciones hace falta un email' });
        if (!(await optIn(customer._id, 'staff'))) {
          return res.status(409).json({ message: 'Este cliente se dio de baja de las comunicaciones y no se le puede volver a suscribir' });
        }
      } else {
        await optOut(customer._id);
      }
      return res.json(await Customer.findById(customer._id));
    }
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

/**
 * Deletes a customer and anonymizes their appointments/reservations (RGPD
 * right to erasure). Refused while they still have something booked ahead:
 * cancel it first, so nobody turns up to an appointment nobody knows about.
 */
exports.deleteCustomer = async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!customer) return res.status(404).json({ message: 'Cliente no encontrado' });

    const upcoming = await upcomingFor(req.businessId, customer);
    if (upcoming.length) {
      const what = upcoming.map((u) => `${u.count} ${u.label}`).join(' y ');
      return res.status(409).json({ code: 'HAS_UPCOMING', upcoming, message: `Tiene ${what} por delante. Cancélalas antes de borrar sus datos.` });
    }
    const erased = await eraseFor(req.businessId, customer);
    await customer.deleteOne();
    res.json({ message: 'Cliente eliminado', erased });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/** Everything the business keeps about one customer, as JSON (RGPD right of access). */
exports.exportCustomer = async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, businessId: req.businessId }).lean();
    if (!customer) return res.status(404).json({ message: 'Cliente no encontrado' });
    const data = {
      exportado: new Date().toISOString(),
      cliente: {
        nombre: customer.name, telefono: customer.phone || '', email: customer.email || '', notas: customer.notes || '',
        vip: !!customer.vip, baja_de_avisos: !!customer.marketingUnsubscribed, creado: customer.createdAt,
      },
      ...(await exportFor(req.businessId, customer)),
    };
    const slug = String(customer.name || 'cliente').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cliente';
    res.setHeader('Content-Disposition', `attachment; filename="datos-${slug}.json"`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  // Formulas are not executed when opened in a spreadsheet
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[";\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** All customers as CSV (for the owner: backups, moving to another tool). */
exports.exportCustomersCsv = async (req, res) => {
  try {
    const rows = await Customer.find({ businessId: req.businessId }).sort({ name: 1 }).lean();
    const head = ['nombre', 'telefono', 'email', 'notas', 'vip', 'baja_avisos', 'creado'];
    const lines = [head.join(';')].concat(rows.map((c) => [
      c.name, c.phone || '', c.email || '', c.notes || '', c.vip ? 'si' : '', c.marketingUnsubscribed ? 'si' : '',
      c.createdAt ? new Date(c.createdAt).toISOString().slice(0, 10) : '',
    ].map(csvCell).join(';')));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="clientes.csv"');
    res.send(`\uFEFF${lines.join('\r\n')}\r\n`);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/** POST /customers/import { rows: [{ name, phone, email, notes }] } — see services/customerImport. */
exports.importCustomers = async (req, res) => {
  try {
    const { importCustomers } = require('../services/customerImport');
    res.json(await importCustomers(req.businessId, req.body?.rows));
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

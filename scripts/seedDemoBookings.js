/**
 * seedDemoBookings.js
 *
 * Fills one appointments business with fake customers and bookings for a month, so the
 * agenda, Caja and statistics have something to show. Everything it creates is tagged
 * (internal note "[demo]" and e-mails @demo.vetra.invalid), so it can be removed again.
 *
 * Usage (MONGO_URI in .env or in the environment):
 *   node scripts/seedDemoBookings.js --business=<slug|id> [--month=2026-10]   add the data
 *   node scripts/seedDemoBookings.js --business=<slug|id> [--month=2026-10] --remove   delete it
 *
 * Past days become completed + paid (some cancelled / no-show), future days confirmed.
 * Monday to Saturday, 10:00-20:00, without overlapping per professional.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const Business = require('../core/models/Business');
const Customer = require('../core/models/Customer');
const Booking = require('../modules/bookings/models/Booking');
const Resource = require('../modules/bookings/models/Resource');
const Service = require('../modules/bookings/models/Service');
const { zonedDateTimeToUtc } = require('../core/lib/timezone');

const TAG = '[demo]';
const DOMAIN = '@demo.vetra.invalid';
const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1];

// Small deterministic generator: same month, same data.
let seed = 20261018;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (list) => list[Math.floor(rnd() * list.length)];

const FIRST = ['Ana', 'Marta', 'Laura', 'Carmen', 'Lucía', 'Paula', 'Elena', 'Sara', 'Noa', 'Julia', 'Clara', 'Irene', 'Marina', 'Claudia', 'Alba', 'Eva', 'Nuria', 'Sofía', 'Jordi', 'Pau', 'Marc', 'Pedro', 'Joan', 'Álex'];
const LAST = ['López', 'García', 'Martí', 'Roca', 'Font', 'Puig', 'Serra', 'Vidal', 'Ferrer', 'Soler', 'Pons', 'Mas', 'Ruiz', 'Torres', 'Moreno', 'Navarro'];
const NOTES = ['', '', '', '', 'Primera visita', 'Alergia al látex', 'Prefiere cita por la tarde', 'Viene con su hija'];

const pad = (n) => String(n).padStart(2, '0');

async function run() {
  const id = arg('business');
  if (!id) throw new Error('Falta --business=<slug|id>');
  await mongoose.connect(process.env.MONGO_URI);
  const business = await Business.findOne(mongoose.isValidObjectId(id) ? { $or: [{ _id: id }, { slug: id }] } : { slug: id });
  if (!business) throw new Error(`No encuentro el negocio "${id}"`);
  const businessId = business._id;
  const tz = business.timezone || 'Europe/Madrid';
  const now = new Date();
  const month = arg('month') || `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  const [year, mon] = month.split('-').map(Number);
  console.log(`Negocio: ${business.name} (${tz}) · mes ${month}`);

  const fromDate = zonedDateTimeToUtc(`${month}-01`, '00:00', tz);
  const toDate = zonedDateTimeToUtc(`${mon === 12 ? year + 1 : year}-${pad(mon === 12 ? 1 : mon + 1)}-01`, '00:00', tz);

  const removed = await Booking.deleteMany({ businessId, internalNotes: new RegExp(`^\\${TAG}`), start: { $gte: fromDate, $lt: toDate } });
  console.log(`Citas demo anteriores borradas: ${removed.deletedCount}`);
  if (process.argv.includes('--remove')) {
    const c = await Customer.deleteMany({ businessId, email: new RegExp(`${DOMAIN.replace('.', '\\.')}$`) });
    console.log(`Clientes demo borrados: ${c.deletedCount}`);
    return;
  }

  const staff = await Resource.find({ businessId, kind: 'staff', active: true }).sort({ sortOrder: 1 });
  const services = await Service.find({ businessId, active: { $ne: false }, bookingMode: { $ne: 'quote' } });
  if (!staff.length || !services.length) throw new Error('El negocio necesita profesionales y servicios');

  // Customers: reuse the demo ones if they exist.
  let customers = await Customer.find({ businessId, email: new RegExp(`${DOMAIN.replace('.', '\\.')}$`) });
  if (!customers.length) {
    const docs = [];
    for (let i = 0; i < 60; i += 1) {
      const name = `${pick(FIRST)} ${pick(LAST)}`;
      const phone = `6${Math.floor(10000000 + rnd() * 89999999)}`;
      docs.push({ businessId, name, phone, normalizedPhone: phone, email: `demo${i}${DOMAIN}`, notes: pick(NOTES) });
    }
    customers = await Customer.insertMany(docs);
  }

  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const daysInMonth = new Date(year, mon, 0).getDate();
  const bookings = [];
  const visits = {};

  for (let day = 1; day <= daysInMonth; day += 1) {
    const dateStr = `${month}-${pad(day)}`;
    if (new Date(year, mon - 1, day).getDay() === 0) continue;   // Sunday closed
    const past = dateStr < today;

    for (const member of staff) {
      let minute = 10 * 60 + Math.floor(rnd() * 3) * 15;
      while (minute < 19 * 60) {
        if (rnd() < 0.2) { minute += 30; continue; }                 // gaps in the day
        const service = pick(services);
        const dur = service.durationMin;
        if (minute + dur > 20 * 60) break;
        const start = zonedDateTimeToUtc(dateStr, `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`, tz);
        const end = new Date(start.getTime() + dur * 60000);
        const busyStart = new Date(start.getTime() - (service.bufferBeforeMin || 0) * 60000);
        const busyEnd = new Date(end.getTime() + (service.bufferAfterMin || 0) * 60000);
        const customer = pick(customers);
        const price = service.price?.amount || 0;
        const roll = rnd();
        let status = past ? 'completed' : 'confirmed';
        if (roll < 0.06) status = 'cancelled';
        else if (past && roll < 0.09) status = 'no_show';
        const paid = status === 'completed';
        const method = pick(['card', 'card', 'cash', 'bizum']);
        const tip = paid && rnd() < 0.15 ? 100 + Math.floor(rnd() * 3) * 100 : 0;
        bookings.push({
          businessId, customerId: customer._id, guestName: customer.name, guestPhone: customer.phone, guestEmail: customer.email,
          status, start, end, partySize: 1,
          segments: [{ serviceId: service._id, serviceName: service.name, start, end, busyStart, busyEnd, resourceIds: [member._id], price }],
          source: pick(['online', 'online', 'phone', 'staff', 'walk_in']),
          internalNotes: TAG, totalPrice: price,
          cancelledAt: status === 'cancelled' ? new Date(start.getTime() - 86400000) : null,
          payment: paid ? { method, services: price, extras: [], discount: 0, tip, total: price, date: dateStr, paidAt: end, paidBy: null, note: '' } : null,
        });
        if (paid) visits[customer._id] = (visits[customer._id] || 0) + 1;
        minute += dur + (service.bufferAfterMin || 0) + Math.floor(rnd() * 3) * 15;
      }
    }
  }

  await Booking.insertMany(bookings);
  await Promise.all(Object.entries(visits).map(([cid, n]) => Customer.updateOne({ _id: cid }, { $inc: { visits: n } })));
  console.log(`Creadas ${bookings.length} citas para ${staff.length} profesionales y ${customers.length} clientes demo.`);
}

run().then(() => mongoose.disconnect()).catch((err) => { console.error('❌', err.message); process.exit(1); });

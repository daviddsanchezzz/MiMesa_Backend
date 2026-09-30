/**
 * Starting point for restaurants: lunch and dinner shifts and one dining room
 * with a few tables, so the booking page works from the first day.
 */
const { registerTemplate } = require('../../core/lib/businessTemplates');
const Room = require('./models/Room');
const Table = require('./models/Table');
const Shift = require('./models/Shift');

registerTemplate({
  key: 'restaurante',
  label: 'Restaurante',
  description: 'Comida y cena, una sala con 8 mesas',
  businessType: 'restaurant',
  apply: async (business) => {
    const room = await Room.create({ businessId: business._id, name: 'Sala', capacity: 40 });
    const sizes = [2, 2, 4, 4, 4, 4, 6, 8];
    await Table.insertMany(sizes.map((capacity, i) => ({
      businessId: business._id, roomId: room._id, name: `Mesa ${i + 1}`, capacity, shape: capacity > 4 ? 'rect' : 'square',
    })));
    await Shift.insertMany([
      { businessId: business._id, name: 'Comida', startTime: '13:00', endTime: '16:00', days: [0, 2, 3, 4, 5, 6], interval: 30 },
      { businessId: business._id, name: 'Cena', startTime: '20:00', endTime: '23:00', days: [4, 5, 6], interval: 30 },
    ]);
  },
});

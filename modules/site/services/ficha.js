/**
 * Loads what the schedule is made of (turnos, vacations, closure exceptions of the restaurant vertical) and
 * builds the website's view of it. A module cannot import a vertical, so its models are looked up by name.
 */
const mongoose = require('mongoose');
const schedule = require('../lib/schedule');
const Business = require('../../../core/models/Business');

async function loadSchedule(businessId) {
  const Shift = mongoose.models.Shift;
  const Vacation = mongoose.models.Vacation;
  const Exception = mongoose.models.Exception;
  const [shifts, vacations, exceptions, business] = await Promise.all([
    Shift ? Shift.find({ businessId }).select('name startTime endTime days startDate endDate interval subShifts').lean() : [],
    Vacation ? Vacation.find({ businessId }).select('startDate endDate reason').lean() : [],
    // Only closures matter here, and only recent or future ones
    Exception ? Exception.find({ businessId, type: 'closed', date: { $gte: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10) } }).select('date shiftName type message').lean() : [],
    Business.findById(businessId).select('reservationDuration').lean(),
  ]);
  // The website closes when the last table has had its time, not when booking ends
  const stay = business?.reservationDuration || 0;
  return { shifts: shifts.map((s) => ({ ...s, endTime: schedule.serviceEnd(s, stay) })), vacations, exceptions };
}

async function scheduleFor(businessId, timezone, instant = new Date()) {
  return schedule.build(await loadSchedule(businessId), schedule.localNow(instant, timezone));
}

module.exports = { loadSchedule, scheduleFor };

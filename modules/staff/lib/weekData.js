const StaffAssignment = require('../models/StaffAssignment');
const Business = require('../../../core/models/Business');
const { businessTimezone, todayInTimezone } = require('../../../core/lib/timezone');
const { snapshotRow } = require('./scheduleDiff');

const SHIFT_FIELDS = 'name startTime endTime staffStartTime staffEndTime';

/** The week as the manager has it now (the draft), one snapshot row per assignment. */
async function loadWeekRows(businessId, days) {
  const assignments = await StaffAssignment.find({ businessId, date: { $gte: days[0], $lte: days[6] } })
    .populate('shiftId', SHIFT_FIELDS).lean();
  return assignments.map((a) => snapshotRow({ ...a, shift: a.shiftId && a.shiftId._id ? a.shiftId : null, shiftId: a.shiftId?._id || a.shiftId }));
}

/** Today's date at the business (YYYY-MM-DD). */
async function businessToday(businessId) {
  const business = await Business.findById(businessId).select('timezone').lean();
  return todayInTimezone(businessTimezone(business));
}

module.exports = { loadWeekRows, businessToday, SHIFT_FIELDS };

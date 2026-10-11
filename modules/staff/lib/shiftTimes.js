/**
 * A shift has the hours customers can book (startTime–endTime) and, optionally,
 * the hours the staff work (staffStartTime–staffEndTime): they arrive before
 * opening and leave after closing. Staff hours fall back to the customer ones.
 */
const staffTimesOf = (shift) => ({
  start: shift?.staffStartTime || shift?.startTime || '',
  end: shift?.staffEndTime || shift?.endTime || '',
});

module.exports = { staffTimesOf };

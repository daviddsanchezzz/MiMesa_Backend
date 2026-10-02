const Vacation = require('../models/Vacation');

exports.getVacations = async (req, res) => {
  try {
    const vacations = await Vacation.find({ businessId: req.businessId }).sort({ startDate: 1 });
    res.json(vacations);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/vacations/check?date=YYYY-MM-DD
exports.checkDate = async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ message: 'date requerido' });
    const vacation = await Vacation.findOne({
      businessId: req.businessId,
      startDate: { $lte: date },
      endDate:   { $gte: date },
    });
    res.json({ closed: !!vacation, reason: vacation?.reason || null });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.createVacation = async (req, res) => {
  try {
    const { startDate, endDate, reason } = req.body;
    if (!startDate || !endDate) return res.status(400).json({ message: 'Las fechas son obligatorias' });
    if (startDate > endDate) return res.status(400).json({ message: 'La fecha de inicio debe ser anterior o igual a la de fin' });
    const vacation = await Vacation.create({
      businessId: req.businessId, startDate, endDate, reason: reason || '',
    });
    res.status(201).json(vacation);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

exports.deleteVacation = async (req, res) => {
  try {
    await Vacation.findOneAndDelete({ _id: req.params.id, businessId: req.businessId });
    res.json({ message: 'Período eliminado' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/vacations/public/check?date=YYYY-MM-DD&businessId=...
exports.checkPublicDate = async (req, res) => {
  try {
    const { date, businessId } = req.query;
    if (!date) return res.status(400).json({ message: 'date requerido' });
    if (!businessId) return res.status(400).json({ message: 'businessId requerido' });
    const vacation = await Vacation.findOne({
      businessId,
      startDate: { $lte: date },
      endDate:   { $gte: date },
    });
    res.json({ closed: !!vacation, reason: vacation?.reason || null });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

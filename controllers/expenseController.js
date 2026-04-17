const Expense = require('../models/Expense');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function getExpenses(req, res) {
  try {
    const { from, to, category, supplierId } = req.query;
    const filter = { businessId: req.businessId };

    if (from || to) {
      filter.expenseDate = {};
      if (from) filter.expenseDate.$gte = from;
      if (to) filter.expenseDate.$lte = to;
    }
    if (category) filter.category = category;
    if (supplierId) filter.supplierId = supplierId;

    const expenses = await Expense.find(filter)
      .sort({ expenseDate: -1, createdAt: -1 })
      .populate('supplierId', 'name')
      .lean();

    res.json(expenses);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function createExpense(req, res) {
  try {
    const { category, amount, expenseDate, supplierId, notes, attachmentUrl, isRecurring } = req.body;

    if (!category) return res.status(400).json({ message: 'La categoría es obligatoria' });
    if (!amount || isNaN(amount) || Number(amount) <= 0)
      return res.status(400).json({ message: 'El importe debe ser mayor que 0' });
    if (!expenseDate || !DATE_RE.test(expenseDate))
      return res.status(400).json({ message: 'La fecha es obligatoria (YYYY-MM-DD)' });

    const expense = await Expense.create({
      businessId: req.businessId,
      supplierId: supplierId || null,
      category,
      amount: Number(amount),
      expenseDate,
      notes: notes || '',
      attachmentUrl: attachmentUrl || '',
      isRecurring: !!isRecurring,
      createdBy: req.user?.id || null,
    });

    const populated = await Expense.findById(expense._id).populate('supplierId', 'name').lean();
    res.status(201).json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function updateExpense(req, res) {
  try {
    const expense = await Expense.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!expense) return res.status(404).json({ message: 'Gasto no encontrado' });

    const { category, amount, expenseDate, supplierId, notes, attachmentUrl, isRecurring } = req.body;
    if (category !== undefined) expense.category = category;
    if (amount !== undefined) expense.amount = Number(amount);
    if (expenseDate !== undefined) expense.expenseDate = expenseDate;
    if (supplierId !== undefined) expense.supplierId = supplierId || null;
    if (notes !== undefined) expense.notes = notes;
    if (attachmentUrl !== undefined) expense.attachmentUrl = attachmentUrl;
    if (isRecurring !== undefined) expense.isRecurring = isRecurring;

    await expense.save();
    const populated = await Expense.findById(expense._id).populate('supplierId', 'name').lean();
    res.json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function deleteExpense(req, res) {
  try {
    const expense = await Expense.findOneAndDelete({ _id: req.params.id, businessId: req.businessId });
    if (!expense) return res.status(404).json({ message: 'Gasto no encontrado' });
    res.json({ message: 'Gasto eliminado' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

module.exports = { getExpenses, createExpense, updateExpense, deleteExpense };

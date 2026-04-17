const Expense          = require('../models/Expense');
const RecurringExpense = require('../models/RecurringExpense');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── Expenses ──────────────────────────────────────────────────────────────────

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
      .populate('recurringExpenseId', 'dayOfMonth')
      .lean();

    res.json(expenses);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function createExpense(req, res) {
  try {
    const { category, amount, expenseDate, supplierId, notes, attachmentUrl, isRecurring, dayOfMonth } = req.body;

    if (!category) return res.status(400).json({ message: 'La categoría es obligatoria' });
    if (!amount || isNaN(amount) || Number(amount) <= 0)
      return res.status(400).json({ message: 'El importe debe ser mayor que 0' });
    if (!expenseDate || !DATE_RE.test(expenseDate))
      return res.status(400).json({ message: 'La fecha es obligatoria (YYYY-MM-DD)' });

    let recurringExpenseId = null;

    if (isRecurring) {
      // Derive dayOfMonth from the provided value or from the expense date
      const dom = dayOfMonth
        ? Math.min(Math.max(parseInt(dayOfMonth, 10), 1), 31)
        : parseInt(expenseDate.slice(8, 10), 10);

      const template = await RecurringExpense.create({
        businessId: req.businessId,
        supplierId: supplierId || null,
        category,
        amount: Number(amount),
        dayOfMonth: dom,
        notes: notes || '',
        createdBy: req.user?.id || null,
      });
      recurringExpenseId = template._id;
    }

    const expense = await Expense.create({
      businessId:         req.businessId,
      supplierId:         supplierId || null,
      category,
      amount:             Number(amount),
      expenseDate,
      notes:              notes || '',
      attachmentUrl:      attachmentUrl || '',
      isRecurring:        !!isRecurring,
      recurringExpenseId,
      createdBy:          req.user?.id || null,
    });

    const populated = await Expense.findById(expense._id)
      .populate('supplierId', 'name')
      .populate('recurringExpenseId', 'dayOfMonth')
      .lean();
    res.status(201).json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function updateExpense(req, res) {
  try {
    const expense = await Expense.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!expense) return res.status(404).json({ message: 'Gasto no encontrado' });

    const { category, amount, expenseDate, supplierId, notes, attachmentUrl } = req.body;
    if (category !== undefined)    expense.category    = category;
    if (amount !== undefined)      expense.amount      = Number(amount);
    if (expenseDate !== undefined) expense.expenseDate = expenseDate;
    if (supplierId !== undefined)  expense.supplierId  = supplierId || null;
    if (notes !== undefined)       expense.notes       = notes;
    if (attachmentUrl !== undefined) expense.attachmentUrl = attachmentUrl;
    // isRecurring / recurringExpenseId are not editable after creation

    await expense.save();
    const populated = await Expense.findById(expense._id)
      .populate('supplierId', 'name')
      .populate('recurringExpenseId', 'dayOfMonth')
      .lean();
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

// ── Recurring templates ───────────────────────────────────────────────────────

async function getTemplates(req, res) {
  try {
    const templates = await RecurringExpense.find({ businessId: req.businessId })
      .sort({ isActive: -1, dayOfMonth: 1 })
      .populate('supplierId', 'name')
      .lean();
    res.json(templates);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function updateTemplate(req, res) {
  try {
    const template = await RecurringExpense.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!template) return res.status(404).json({ message: 'Plantilla no encontrada' });

    const { isActive, notes, amount, dayOfMonth } = req.body;
    if (isActive !== undefined)   template.isActive   = isActive;
    if (notes !== undefined)      template.notes      = notes;
    if (amount !== undefined)     template.amount     = Number(amount);
    if (dayOfMonth !== undefined) template.dayOfMonth = Math.min(Math.max(parseInt(dayOfMonth, 10), 1), 31);

    await template.save();
    res.json(template);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function deleteTemplate(req, res) {
  try {
    const template = await RecurringExpense.findOneAndDelete({ _id: req.params.id, businessId: req.businessId });
    if (!template) return res.status(404).json({ message: 'Plantilla no encontrada' });
    // Unlink any expenses that referenced this template (keep the expenses, just remove the link)
    await Expense.updateMany(
      { businessId: req.businessId, recurringExpenseId: template._id },
      { $set: { recurringExpenseId: null } },
    );
    res.json({ message: 'Plantilla eliminada' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

module.exports = {
  getExpenses, createExpense, updateExpense, deleteExpense,
  getTemplates, updateTemplate, deleteTemplate,
};

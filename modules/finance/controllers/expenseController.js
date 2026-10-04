const Expense          = require('../models/Expense');
const RecurringExpense = require('../models/RecurringExpense');
const Supplier         = require('../../purchases/models/Supplier');
const Business         = require('../../../core/models/Business');
const { calculateStaffCostForRange } = require('../../staff/lib/staffCosts');
const { teamReport } = require('../../bookings/services/teamService');
const mongoose         = require('mongoose');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function validSupplier(businessId, supplierId) {
  if (!supplierId) return true;
  if (!mongoose.Types.ObjectId.isValid(supplierId)) return false;
  return Boolean(await Supplier.exists({ _id: supplierId, businessId }));
}

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
    // Staff costs come from the staff/team modules. Legacy persisted rows must
    // not be counted alongside those calculated entries.
    filter.category = category || { $ne: 'staff' };
    if (supplierId) {
      if (!mongoose.Types.ObjectId.isValid(supplierId)) return res.status(400).json({ message: 'Proveedor no valido' });
      filter.supplierId = supplierId;
    }

    const expenses = await Expense.find(filter)
      .sort({ expenseDate: -1, createdAt: -1 })
      .populate('supplierId', 'name')
      .populate('recurringExpenseId', 'dayOfMonth')
      .populate('invoiceId', 'invoiceNumber status')
      .lean();

    // Salary and commission costs are calculated from the team configuration,
    // not persisted as Expense rows. Expose read-only ledger entries so the
    // Gastos tab reconciles with the dashboard total without duplicating data.
    const automatic = [];
    if (from && to && !category && !supplierId) {
      const business = await Business.findById(req.businessId).select('businessType').lean();
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const expenseDate = to < today ? to : today;
      if (business?.businessType === 'appointments') {
        const team = await teamReport(req.businessId, from, to, new Date(), { ensure: false });
        for (const person of team.staff || []) {
          if (person.salary > 0) automatic.push({
            _id: `automatic:staff:${person.id}:${from}:${to}`,
            category: 'staff', amount: person.salary, expenseDate,
            notes: `Coste de ${person.name}`, sourceType: 'AUTOMATIC',
            automaticKind: 'salary', professionalName: person.name,
          });
          if (person.commission > 0) automatic.push({
            _id: `automatic:commission:${person.id}:${from}:${to}`,
            category: 'commissions', amount: person.commission, expenseDate,
            notes: person.pay?.commissionPercent != null
              ? `${person.name} · ${person.pay.commissionPercent}%`
              : person.name,
            sourceType: 'AUTOMATIC', automaticKind: 'commission',
            professionalName: person.name,
          });
        }
      } else {
        const staffCost = await calculateStaffCostForRange(req.businessId, from, to);
        if (staffCost > 0) automatic.push({
          _id: `automatic:staff:${from}:${to}`,
          category: 'staff', amount: staffCost, expenseDate,
          notes: 'Coste de personal', sourceType: 'AUTOMATIC', automaticKind: 'salary',
        });
      }
    }

    res.json([...expenses, ...automatic].sort((a, b) =>
      b.expenseDate.localeCompare(a.expenseDate) || String(b.createdAt || '').localeCompare(String(a.createdAt || ''))));
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
    if (!(await validSupplier(req.businessId, supplierId)))
      return res.status(400).json({ message: 'El proveedor no pertenece a este negocio' });

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
      sourceType:          isRecurring ? 'RECURRING' : 'MANUAL',
      sourceId:            recurringExpenseId,
      createdBy:          req.user?.id || null,
    });

    const populated = await Expense.findById(expense._id)
      .populate('supplierId', 'name')
      .populate('recurringExpenseId', 'dayOfMonth')
      .populate('invoiceId', 'invoiceNumber status')
      .lean();
    res.status(201).json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function updateExpense(req, res) {
  try {
    const { scope = 'single', category, amount, expenseDate, supplierId, notes, attachmentUrl } = req.body;

    const expense = await Expense.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!expense) return res.status(404).json({ message: 'Gasto no encontrado' });
    if (expense.sourceType === 'INVOICE') return res.status(409).json({ message: 'Este gasto se actualiza desde su factura' });
    if (supplierId !== undefined && !(await validSupplier(req.businessId, supplierId)))
      return res.status(400).json({ message: 'El proveedor no pertenece a este negocio' });

    if (category !== undefined)      expense.category      = category;
    if (amount !== undefined)        expense.amount        = Number(amount);
    if (expenseDate !== undefined)   expense.expenseDate   = expenseDate;
    if (supplierId !== undefined)    expense.supplierId    = supplierId || null;
    if (notes !== undefined)         expense.notes         = notes;
    if (attachmentUrl !== undefined) expense.attachmentUrl = attachmentUrl;
    // isRecurring / recurringExpenseId are not editable after creation

    await expense.save();

    // Propagate to template + sibling expenses for 'future' and 'all' scopes
    if (scope !== 'single' && expense.recurringExpenseId) {
      // Fields shared between Expense and RecurringExpense
      const shared = {};
      if (category !== undefined)   shared.category   = category;
      if (amount !== undefined)     shared.amount     = Number(amount);
      if (supplierId !== undefined) shared.supplierId = supplierId || null;
      if (notes !== undefined)      shared.notes      = notes;

      if (Object.keys(shared).length > 0) {
        await RecurringExpense.updateOne(
          { _id: expense.recurringExpenseId, businessId: req.businessId },
          { $set: shared },
        );

        const siblingFilter = {
          businessId: req.businessId,
          recurringExpenseId: expense.recurringExpenseId,
          _id: { $ne: expense._id },
        };
        if (scope === 'future') {
          // Only expenses dated after this one (this one is already saved above)
          siblingFilter.expenseDate = { $gt: expense.expenseDate };
        }
        await Expense.updateMany(siblingFilter, { $set: shared });
      }
    }

    const populated = await Expense.findById(expense._id)
      .populate('supplierId', 'name')
      .populate('recurringExpenseId', 'dayOfMonth')
      .populate('invoiceId', 'invoiceNumber status')
      .lean();
    res.json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function deleteExpense(req, res) {
  try {
    const { scope = 'single' } = req.query;

    const expense = await Expense.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!expense) return res.status(404).json({ message: 'Gasto no encontrado' });
    if (expense.sourceType === 'INVOICE') return res.status(409).json({ message: 'Elimina la factura para retirar este gasto reconocido' });
    await expense.deleteOne();

    if (scope !== 'single' && expense.recurringExpenseId) {
      const templateId = expense.recurringExpenseId;

      if (scope === 'future') {
        // Delete this and all future instances
        await Expense.deleteMany({
          businessId: req.businessId,
          recurringExpenseId: templateId,
          expenseDate: { $gte: expense.expenseDate },
        });
        // Unlink any remaining past instances so they don't reference a missing template
        await Expense.updateMany(
          { businessId: req.businessId, recurringExpenseId: templateId },
          { $set: { recurringExpenseId: null } },
        );
      } else if (scope === 'all') {
        // Delete every instance linked to this template
        await Expense.deleteMany({ businessId: req.businessId, recurringExpenseId: templateId });
      }

      // Remove the template in both cases so the cron stops generating new ones
      await RecurringExpense.findOneAndDelete({ _id: templateId, businessId: req.businessId });
    }

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

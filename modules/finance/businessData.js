const { registerBusinessData, deleteAllFor } = require('../../core/lib/businessData');

registerBusinessData({
  key: 'finance',
  erase: (businessId) => deleteAllFor(businessId, {
    Expense: require('./models/Expense'),
    RecurringExpense: require('./models/RecurringExpense'),
    DailyRevenue: require('./models/DailyRevenue'),
    BusinessCategory: require('./models/BusinessCategory'),
  }),
});

const { registerBusinessData, deleteAllFor } = require('../../core/lib/businessData');

registerBusinessData({
  key: 'menu',
  erase: (businessId) => deleteAllFor(businessId, {
    MenuItem: require('./models/MenuItem'),
    MenuCategory: require('./models/MenuCategory'),
    MenuSettings: require('./models/MenuSettings'),
  }),
});

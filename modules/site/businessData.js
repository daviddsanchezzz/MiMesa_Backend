const { registerBusinessData, deleteAllFor } = require('../../core/lib/businessData');

registerBusinessData({
  key: 'site',
  erase: (businessId) => deleteAllFor(businessId, { SiteProfile: require('./models/SiteProfile') }),
});

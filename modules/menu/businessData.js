const { registerBusinessData, deleteAllFor } = require('../../core/lib/businessData');

const photos = require('./services/photoStorage');

registerBusinessData({
  key: 'menu',
  erase: async (businessId) => {
    // Photos first: if the purge fails the data stays and the erasure can be retried
    const removedPhotos = await photos.removeBusiness(businessId);
    const counts = await deleteAllFor(businessId, {
      MenuItem: require('./models/MenuItem'),
      MenuCategory: require('./models/MenuCategory'),
      MenuSettings: require('./models/MenuSettings'),
      DailyMenu: require('./models/DailyMenu'),
    });
    return { ...counts, photos: removedPhotos };
  },
});

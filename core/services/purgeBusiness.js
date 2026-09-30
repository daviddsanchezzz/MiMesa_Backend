/**
 * Deletes a business and everything stored for it (customers, team, module
 * data). Legal acceptances are kept: they are the proof of what was accepted.
 */
const Business = require('../models/Business');
const { eraseModuleData, deleteAllFor } = require('../lib/businessData');

async function purgeBusiness(businessId) {
  const modules = await eraseModuleData(businessId);
  const core = await deleteAllFor(businessId, {
    Customer: require('../models/Customer'),
    Invitation: require('../models/Invitation'),
    BusinessMember: require('../models/BusinessMember'),
    MarketingCampaign: require('../models/MarketingCampaign'),
    PushSubscription: require('../models/PushSubscription'),
  });
  await Business.deleteOne({ _id: businessId });
  return { modules, core };
}

module.exports = { purgeBusiness };

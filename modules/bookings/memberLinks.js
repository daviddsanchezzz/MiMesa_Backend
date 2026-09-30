/**
 * Invitation link "resourceId": the invited person is this professional in the
 * agenda (sees "Mi agenda"). Applied when they accept the invitation.
 */
const mongoose = require('mongoose');
const { registerMemberLink, MemberLinkError } = require('../../core/lib/memberLinks');
const Resource = require('./models/Resource');
const Invitation = require('../../core/models/Invitation');

registerMemberLink({
  key: 'resourceId',
  async validate({ businessId, value, email }) {
    if (!mongoose.isValidObjectId(value)) throw new MemberLinkError('Profesional no válido');
    const resource = await Resource.findOne({ _id: value, businessId, kind: 'staff', active: true }).lean();
    if (!resource) throw new MemberLinkError('Ese profesional no existe en este negocio');
    if (resource.userId) throw new MemberLinkError(`${resource.name} ya está vinculado a otra cuenta`, 409);
    const other = await Invitation.exists({
      businessId, status: 'pending', expiresAt: { $gt: new Date() },
      'links.resourceId': String(resource._id), ...(email ? { email: { $ne: email } } : {}),
    });
    if (other) throw new MemberLinkError(`Ya hay una invitación pendiente para ${resource.name}`, 409);
    return String(resource._id);
  },
  async apply({ businessId, userId, value }) {
    // A person is one professional: unlink them from any other first
    await Resource.updateMany({ businessId, userId, _id: { $ne: value } }, { $set: { userId: null } });
    await Resource.updateOne({ _id: value, businessId, kind: 'staff' }, { $set: { userId } });
  },
});

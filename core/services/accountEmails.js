/**
 * Emails about the Vetra account itself (sent as Vetra, violet brand):
 * email verification, password reset and team invitations. Plus the layout
 * of marketing campaigns a business sends to its customers.
 * Pure builders: { subject, html }.
 */
const { escapeHtml: esc } = require('../lib/escapeHtml');
const d = require('./emailDesign');

const ROLE_LABEL = { owner: 'propietario', manager: 'encargado', staff: 'personal' };

function vetraEmail({ title, preheader, content }) {
  return d.layout({ brand: d.VETRA_BRAND, title, preheader, content });
}

function buildVerifyEmail({ name, url }) {
  const who = esc(d.firstName(name));
  return {
    subject: 'Confirma tu email para empezar con Vetra',
    html: vetraEmail({
      title: 'Confirma tu email',
      preheader: 'Un clic y tu cuenta queda lista.',
      content: `${d.h1('Confirma tu email')}
        ${d.p(`${who ? `Hola ${who}, gracias` : 'Gracias'} por registrarte en Vetra. Confirma que este email es tuyo y empieza a gestionar tu negocio.`)}
        ${d.buttons([{ href: url, label: 'Confirmar mi email' }])}
        ${d.small('El enlace caduca en 24 horas. Si no has creado una cuenta en Vetra, ignora este email.')}`,
    }),
  };
}

function buildResetPasswordEmail({ name, url }) {
  const who = esc(d.firstName(name));
  return {
    subject: 'Restablece tu contraseña de Vetra',
    html: vetraEmail({
      title: 'Restablece tu contraseña',
      preheader: 'El enlace caduca en 1 hora.',
      content: `${d.h1('Restablece tu contraseña')}
        ${d.p(`${who ? `Hola ${who}, hemos` : 'Hemos'} recibido una petición para cambiar la contraseña de tu cuenta.`)}
        ${d.buttons([{ href: url, label: 'Elegir nueva contraseña' }])}
        ${d.small('El enlace caduca en 1 hora. Si no lo has pedido tú, ignora este email: tu contraseña no cambiará.')}`,
    }),
  };
}

/** platform: invited to Vetra itself (no business). */
function buildInvitationEmail({ name, businessName = '', role = 'staff', url, platform = false }) {
  const who = esc(d.firstName(name));
  const hello = who ? `Hola ${who}` : 'Hola';
  if (platform) {
    return {
      subject: 'Te han dado acceso a Vetra',
      html: vetraEmail({
        title: 'Bienvenido a Vetra',
        preheader: 'Activa tu cuenta para empezar.',
        content: `${d.h1('Te damos la bienvenida a Vetra')}
          ${d.p(`${hello}, te han dado acceso a <strong>Vetra</strong>, la plataforma para gestionar reservas, agenda, clientes y caja de tu negocio.`)}
          ${d.buttons([{ href: url, label: 'Activar mi cuenta' }])}
          ${d.small('El enlace caduca en 7 días. Si no esperabas esta invitación, ignora este email.')}`,
      }),
    };
  }
  const biz = esc(businessName);
  return {
    subject: `${businessName} te invita a su equipo en Vetra`,
    html: vetraEmail({
      title: `Únete a ${businessName}`,
      preheader: `Te han invitado como ${ROLE_LABEL[role] || 'personal'}.`,
      content: `${d.h1(`Únete al equipo de ${businessName}`)}
        ${d.p(`${hello}, <strong>${biz}</strong> te ha invitado a su equipo en Vetra como <strong>${esc(ROLE_LABEL[role] || 'personal')}</strong>. Desde ahí verás la agenda y podrás trabajar con el resto del equipo.`)}
        ${d.buttons([{ href: url, label: 'Aceptar invitación' }])}
        ${d.small('El enlace caduca en 7 días. Si no esperabas esta invitación, ignora este email.')}`,
    }),
  };
}

/** Vetra created the business for its owner: activate the account and it is ready. */
function buildOwnerWelcomeEmail({ name, businessName, url, expiresDays = 14 }) {
  const who = esc(d.firstName(name));
  const biz = esc(businessName);
  return {
    subject: `Tu cuenta de Vetra para ${businessName} está lista`,
    html: vetraEmail({
      title: `${businessName} ya está en Vetra`,
      preheader: 'Elige tu contraseña y empieza a usarlo hoy.',
      content: `${d.h1(`Todo listo para ${businessName}`)}
        ${d.p(`${who ? `Hola ${who}, hemos` : 'Hemos'} preparado <strong>${biz}</strong> en Vetra para que empieces a trabajar desde el primer día.`)}
        ${d.p('Solo falta que actives tu cuenta: eliges tu contraseña, aceptas las condiciones y entras directamente a tu negocio.')}
        ${d.buttons([{ href: url, label: 'Activar mi cuenta' }])}
        ${d.small(`El enlace caduca en ${expiresDays} días. ¿Alguna duda? Responde a este email y te ayudamos.`)}`,
    }),
  };
}

/** A business's marketing email to one customer (text written by the business). */
function buildCampaignEmail({ business, logoUrl = null, customerName, subject, body, unsubUrl }) {
  const brand = d.brandOf(business, { logoUrl });
  const who = esc(d.firstName(customerName));
  const biz = esc(business?.name || '');
  const text = esc(body || '').replace(/\r?\n/g, '<br>');
  return d.layout({
    brand,
    title: subject || business?.name || '',
    preheader: String(body || '').slice(0, 110),
    content: `${who ? d.p(`Hola ${who},`) : ''}${d.p(text)}`,
    footer: {
      replyHint: true,
      note: `Recibes este email porque eres cliente de ${biz} y aceptaste recibir sus novedades. <a href="${esc(unsubUrl)}" style="color:#6b7280;text-decoration:underline;">Darte de baja</a>.`,
    },
  });
}

module.exports = { buildVerifyEmail, buildResetPasswordEmail, buildInvitationEmail, buildOwnerWelcomeEmail, buildCampaignEmail };

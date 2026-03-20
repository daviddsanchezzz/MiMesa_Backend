const { betterAuth } = require('better-auth');
const { mongodbAdapter } = require('better-auth/adapters/mongodb');
const { twoFactor } = require('better-auth/plugins');
const { admin } = require('better-auth/plugins');
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

// Lazy-created auth instance (needs MongoDB client injected via initAuth)
let _auth = null;

function initAuth(mongoClient) {
  const Business = require('../models/Business');
const BusinessMember = require('../models/BusinessMember');
  const dbName = process.env.MONGO_DB_NAME || 'tpv-simple';

  _auth = betterAuth({
    // mongodbAdapter expects a Db object, not a MongoClient
    database: mongodbAdapter(mongoClient.db(dbName)),

    // Required: secret for signing session cookies
    secret: process.env.BETTER_AUTH_SECRET,

    baseURL: process.env.BACKEND_URL || 'http://localhost:5000',
    basePath: '/api/betterauth',

    trustedOrigins: [
      process.env.FRONTEND_URL || 'http://localhost:3005',
    ],

    // Production cross-origin cookie config (frontend on Netlify, backend on Render)
    advanced: {
      useSecureCookies: process.env.NODE_ENV === 'production',
      cookies: {
        session_token: {
          attributes: {
            sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
            secure:   process.env.NODE_ENV === 'production',
          },
        },
      },
    },

    // ---------- Email / Password ----------
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false, // set to true when email is fully configured
      sendResetPassword: async ({ user, url }) => {
        try {
          await resend.emails.send({
            from: process.env.RESEND_FROM || 'Mimesa <onboarding@resend.dev>',
            to: user.email,
            subject: 'Restablecer contraseña — Mimesa',
            html: `
              <p>Hola,</p>
              <p>Haz clic en el siguiente enlace para restablecer tu contraseña. Caduca en 1 hora.</p>
              <a href="${url}" style="background:#4f46e5;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;">
                Restablecer contraseña
              </a>
              <p style="color:#888;font-size:12px;margin-top:16px;">Si no solicitaste esto, ignora este email.</p>
            `,
          });
        } catch (err) {
          console.error('[BetterAuth] sendResetPassword error:', err.message);
        }
      },
    },

    // ---------- Email verification ----------
    emailVerification: {
      sendOnSignUp: false, // flip to true when email is production-ready
      sendVerificationEmail: async ({ user, url }) => {
        try {
          await resend.emails.send({
            from: process.env.RESEND_FROM || 'Mimesa <onboarding@resend.dev>',
            to: user.email,
            subject: 'Verifica tu email — Mimesa',
            html: `
              <p>Hola ${user.name},</p>
              <p>Haz clic aquí para verificar tu dirección de email:</p>
              <a href="${url}" style="background:#4f46e5;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;">
                Verificar email
              </a>
            `,
          });
        } catch (err) {
          console.error('[BetterAuth] sendVerificationEmail error:', err.message);
        }
      },
    },

    // ---------- Google OAuth ----------
    socialProviders: {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID || '',
        clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
        enabled: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
      },
    },

    // ---------- Plugins ----------
    plugins: [
      // 2FA (TOTP + backup codes). User opts-in from Profile page.
      twoFactor({
        issuer: 'Mimesa',
        otpOptions: { digits: 6, period: 30 },
      }),
      // Admin panel capabilities: list users, ban, impersonate (owner-only)
      admin(),
    ],

    // ---------- Session ----------
    session: {
      expiresIn: 60 * 60 * 24 * 90,  // 90 days
      updateAge: 60 * 60 * 24,        // slide the window each day
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60,               // 5-min signed cookie cache (avoids DB hit on every request)
      },
    },

    // ---------- Additional user fields ----------
    user: {
      additionalFields: {
        phone: { type: 'string', required: false, defaultValue: '' },
      },
    },

    // ---------- After user creation: bootstrap their Business ----------
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            try {
              const Invitation = require('../models/Invitation');

              // Dev users: skip creating a personal Business.
              const { isDev } = require('../middleware/requireDev');
              if (isDev(user.email)) return;

              // Invited users: skip creating a personal Business.
              // acceptInvitation will add them to the correct business.
              const hasPendingInvite = await Invitation.exists({
                email: user.email.toLowerCase(),
                status: 'pending',
                expiresAt: { $gt: new Date() },
              });
              if (hasPendingInvite) return;

              let business = await Business.findOne({ ownerId: user.id });

              if (!business) {
                // Migration: legacy Business with same email but no ownerId
                business = await Business.findOne({ email: user.email.toLowerCase() });
                if (business) {
                  business.ownerId = user.id;
                  await business.save();
                } else {
                  // New user — create fresh Business
                  business = await Business.create({
                    name: user.name || 'Mi Negocio',
                    email: user.email,
                    ownerId: user.id,
                    phone: user.phone || '',
                  });
                }
              }

              // Ensure owner membership record exists (with name/email for display)
              await BusinessMember.findOneAndUpdate(
                { userId: user.id, businessId: business._id },
                { $setOnInsert: { role: 'owner', status: 'active', userName: user.name || '', userEmail: user.email } },
                { upsert: true, new: true },
              );
            } catch (err) {
              console.error('[BetterAuth] Failed to bootstrap Business/Member for user', user.id, err.message);
            }
          },
        },
      },
    },
  });

  return _auth;
}

function getAuth() {
  if (!_auth) throw new Error('Better Auth not initialized. Call initAuth(mongoClient) first.');
  return _auth;
}

module.exports = { initAuth, getAuth };

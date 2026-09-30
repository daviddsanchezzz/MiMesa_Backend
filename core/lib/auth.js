const { betterAuth } = require('better-auth');
const { mongodbAdapter } = require('better-auth/adapters/mongodb');
const { twoFactor, bearer } = require('better-auth/plugins');
const { admin } = require('better-auth/plugins');
const { Resend } = require('resend');
const { sendTrackedEmail } = require('../services/emailDelivery');
const { escapeHtml } = require('./escapeHtml');

let _warnedMissingResendKey = false;
function getResendClient() {
  if (!process.env.RESEND_API_KEY) {
    if (!_warnedMissingResendKey) {
      console.warn('[BetterAuth] RESEND_API_KEY is not configured. Email sending is disabled.');
      _warnedMissingResendKey = true;
    }
    return null;
  }
  return new Resend(process.env.RESEND_API_KEY);
}

// Lazy-created auth instance (needs MongoDB client injected via initAuth)
let _auth = null;

function initAuth(mongoClient) {
  const Business = require('../models/Business');
const BusinessMember = require('../models/BusinessMember');
  const dbName = process.env.MONGO_DB_NAME || 'tpv-simple';
  const normalizeOrigin = (value) => {
    try {
      return new URL(String(value).trim()).origin.toLowerCase();
    } catch {
      return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
    }
  };

  _auth = betterAuth({
    // mongodbAdapter expects a Db object, not a MongoClient
    database: mongodbAdapter(mongoClient.db(dbName)),

    // Required: secret for signing session cookies
    secret: process.env.BETTER_AUTH_SECRET,

    baseURL: process.env.BACKEND_URL || 'http://localhost:5000',
    basePath: '/api/betterauth',

    trustedOrigins: (process.env.FRONTEND_URLS || process.env.FRONTEND_URL || 'http://localhost:3005')
      .split(',')
      .map(o => normalizeOrigin(o))
      .filter(Boolean),

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
      requireEmailVerification: true,
      sendResetPassword: async ({ user, url }) => {
        try {
          const resend = getResendClient();
          if (!resend) return;
          await sendTrackedEmail({
            resend,
            source: 'auth.reset_password',
            metadata: { userId: user.id, userEmail: user.email },
            payload: {
            from: process.env.RESEND_FROM_SYSTEM || 'Vetra <onboarding@resend.dev>',
            to: user.email,
            ...(() => {
              const { buildResetPasswordEmail } = require('../services/accountEmails');
              return buildResetPasswordEmail({ name: user.name, url });
            })(),
            },
          });
        } catch (err) {
          console.error('[BetterAuth] sendResetPassword error:', err.message);
        }
      },
    },

    // ---------- Email verification ----------
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url }) => {
        try {
          // Invited people verify their email by accepting the invitation (it reached their inbox).
          const Invitation = require('../models/Invitation');
          const invited = await Invitation.exists({ email: String(user.email || '').toLowerCase(), status: 'pending', expiresAt: { $gt: new Date() } });
          if (invited) return;

          let verificationLink = url;
          try {
            const parsed = new URL(url);
            const token = parsed.searchParams.get('token');
            const frontendBase = (process.env.FRONTEND_URLS || process.env.FRONTEND_URL || 'http://localhost:3005')
              .split(',')[0]
              .trim();
            if (token && frontendBase) {
              verificationLink = `${frontendBase.replace(/\/$/, '')}/verify-email?token=${encodeURIComponent(token)}`;
            }
          } catch {
            // fallback to provider URL
          }

          const resend = getResendClient();
          if (!resend) return;
          await sendTrackedEmail({
            resend,
            source: 'auth.verify_email',
            metadata: { userId: user.id, userEmail: user.email },
            payload: {
            from: process.env.RESEND_FROM_INVITE || 'Vetra <onboarding@resend.dev>',
            to: user.email,
            ...(() => {
              const { buildVerifyEmail } = require('../services/accountEmails');
              return buildVerifyEmail({ name: user.name, url: verificationLink });
            })(),
            },
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
        issuer: 'Vetra',
        otpOptions: { digits: 6, period: 30 },
      }),
      // Admin panel capabilities: list users, ban, impersonate (owner-only)
      admin(),
      // Bearer token support: required for cross-origin setups (Netlify frontend -> Render backend)
      // Client stores the token in localStorage and sends it as Authorization: Bearer <token>
      bearer(),
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
          // Invite-only mode: only people with a pending invitation (or Vetra devs) can sign up.
          before: async (user) => {
            const { canSignUp } = require('../services/signupGate');
            if (!(await canSignUp(user.email))) {
              const { APIError } = require('better-auth/api');
              throw new APIError('FORBIDDEN', { message: 'Por ahora Vetra funciona por invitación. Solicita acceso y te preparamos tu cuenta.', code: 'INVITE_ONLY' });
            }
          },
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
                  // New user - they will create their Business via the Onboarding page.
                  return;
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

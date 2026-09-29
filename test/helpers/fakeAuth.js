/**
 * Replaces Better Auth with a fake before the app is loaded, so HTTP tests
 * can act as any user without a real login. A request authenticates by
 * sending the header `x-test-user: <userId>` for a user registered here.
 */
const path = require('node:path');

const users = new Map();

function installFakeAuth() {
  const candidates = ['lib/auth', 'core/lib/auth'];
  const root = path.resolve(__dirname, '..', '..');
  let file;
  for (const rel of candidates) {
    try { file = require.resolve(path.join(root, rel)); break; } catch { /* next */ }
  }
  if (!file) throw new Error('auth module not found');
  require(file);
  require.cache[file].exports.getAuth = () => ({
    api: {
      getSession: async ({ headers }) => {
        const id = headers.get('x-test-user');
        const user = id && users.get(id);
        return user ? { user, session: { id: `s-${id}` } } : null;
      },
    },
  });
}

function addUser(user) {
  users.set(user.id, { name: user.name || user.id, email: user.email || `${user.id}@example.test`, ...user });
}

module.exports = { installFakeAuth, addUser };

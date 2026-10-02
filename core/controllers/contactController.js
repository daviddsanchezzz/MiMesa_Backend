const { sendContactEmail } = require('../services/systemEmails');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LIMITS = { name: 100, email: 200, subject: 150, message: 5000 };

exports.submit = async (req, res) => {
  try {
    const { name, email, subject, message } = req.body || {};
    const fields = { name, email, subject, message };

    for (const [key, value] of Object.entries(fields)) {
      if (typeof value !== 'string' || !value.trim()) {
        return res.status(400).json({ message: 'Todos los campos son obligatorios' });
      }
      if (value.trim().length > LIMITS[key]) {
        return res.status(400).json({ message: `El campo ${key} es demasiado largo` });
      }
    }
    if (!EMAIL_RE.test(email.trim())) {
      return res.status(400).json({ message: 'Email no válido' });
    }

    await sendContactEmail({ name: name.trim(), email: email.trim(), subject: subject.trim(), message: message.trim() });
    res.json({ message: 'ok' });
  } catch (err) {
    console.error('[contact] submit failed:', err.message);
    res.status(500).json({ message: 'Error al enviar el mensaje' });
  }
};

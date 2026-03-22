const { sendContactEmail } = require('../services/email');

exports.submit = async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;
    if (!name?.trim() || !email?.trim() || !subject?.trim() || !message?.trim()) {
      return res.status(400).json({ message: 'Todos los campos son obligatorios' });
    }
    await sendContactEmail({ name: name.trim(), email: email.trim(), subject: subject.trim(), message: message.trim() });
    res.json({ message: 'ok' });
  } catch (err) {
    console.error('[contact] submit failed:', err.message);
    res.status(500).json({ message: 'Error al enviar el mensaje' });
  }
};

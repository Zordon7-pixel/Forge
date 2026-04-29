const nodemailer = require('nodemailer');

function parseBoolean(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function getMailConfig() {
  return {
    appUrl: process.env.APP_URL,
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    secure: parseBoolean(process.env.SMTP_SECURE),
    from: process.env.EMAIL_FROM,
  };
}

function isMailConfigured() {
  const config = getMailConfig();
  return Boolean(
    config.appUrl &&
    config.host &&
    config.port &&
    config.user &&
    config.pass &&
    config.from
  );
}

let transporter;

function isResendSmtp(config) {
  return String(config.host || '').toLowerCase() === 'smtp.resend.com' &&
    String(config.user || '').toLowerCase() === 'resend';
}

function getTransporter() {
  if (!isMailConfigured()) {
    throw new Error('SMTP mailer is not configured.');
  }

  if (!transporter) {
    const config = getMailConfig();
    transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: {
        user: config.user,
        pass: config.pass,
      },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });
  }

  return transporter;
}

function buildPasswordResetUrl(token) {
  const { appUrl } = getMailConfig();
  const resetUrl = new URL('/reset-password', appUrl);
  resetUrl.searchParams.set('token', token);
  return resetUrl.toString();
}

async function sendPasswordResetEmail({ to, token }) {
  const config = getMailConfig();
  const { from } = config;
  const resetUrl = buildPasswordResetUrl(token);
  const text = [
    'We received a request to reset your Forge password.',
    '',
    `Reset your password: ${resetUrl}`,
    '',
    'This link expires in 1 hour. If you did not request this, you can ignore this email.',
  ].join('\n');
  const html = `
      <p>We received a request to reset your Forge password.</p>
      <p><a href="${resetUrl}">Reset your password</a></p>
      <p>This link expires in 1 hour. If you did not request this, you can ignore this email.</p>
    `;

  if (isResendSmtp(config)) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.pass}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to,
        subject: 'Reset your Forge password',
        text,
        html,
      }),
    });

    if (!response.ok) {
      let detail = '';
      try {
        const data = await response.json();
        detail = data?.message || data?.error || JSON.stringify(data);
      } catch {
        detail = await response.text().catch(() => '');
      }
      throw new Error(`Resend email failed (${response.status})${detail ? `: ${detail}` : ''}`);
    }

    return;
  }

  await getTransporter().sendMail({
    from,
    to,
    subject: 'Reset your Forge password',
    text,
    html,
  });
}

module.exports = {
  buildPasswordResetUrl,
  isMailConfigured,
  sendPasswordResetEmail,
};

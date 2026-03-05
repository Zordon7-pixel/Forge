const express = require('express');
const router  = express.Router();

const PRIVACY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Privacy Policy — FORGE</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: radial-gradient(circle at 20% -10%, #24304f 0%, #121826 35%, #0b0f18 100%);
      color: #dbe7ff;
      line-height: 1.65;
      min-height: 100vh;
    }
    .container {
      max-width: 860px;
      margin: 0 auto;
      padding: 56px 20px 72px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 28px;
    }
    .brand-mark {
      width: 34px;
      height: 34px;
      border-radius: 9px;
      background: linear-gradient(135deg, #f7c23a 0%, #cd8d00 100%);
      box-shadow: 0 6px 24px rgba(240, 168, 0, 0.35);
    }
    .brand-text {
      font-size: 20px;
      font-weight: 800;
      color: #ffffff;
      letter-spacing: 0.02em;
    }
    h1 {
      font-size: 2rem;
      font-weight: 800;
      color: #ffffff;
      margin-bottom: 10px;
      letter-spacing: -0.02em;
    }
    .subhead {
      color: #a9badb;
      font-size: 0.95rem;
      margin-bottom: 30px;
    }
    h2 {
      font-size: 1.125rem;
      font-weight: 700;
      color: #ffffff;
      margin: 28px 0 10px;
    }
    p {
      color: #bed0ee;
      margin-bottom: 13px;
    }
    ul {
      color: #bed0ee;
      padding-left: 20px;
      margin-bottom: 12px;
    }
    li { margin-bottom: 8px; }
    .panel {
      background: rgba(19, 27, 45, 0.92);
      border: 1px solid #2c3a58;
      border-radius: 16px;
      padding: 24px;
      backdrop-filter: blur(3px);
    }
    a {
      color: #ffd061;
      text-decoration: none;
    }
    a:hover { text-decoration: underline; }
    .muted {
      color: #99afcf;
    }
    footer {
      color: #8ea6cb;
      font-size: 0.85rem;
      margin-top: 26px;
      border-top: 1px solid #2c3a58;
      padding-top: 16px;
    }
    @media (max-width: 640px) {
      .container { padding: 28px 14px 40px; }
      .panel { padding: 18px; border-radius: 14px; }
      h1 { font-size: 1.65rem; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="brand">
      <div class="brand-mark"></div>
      <span class="brand-text">FORGE</span>
    </div>

    <div class="panel">
      <h1>Privacy Policy</h1>
      <p class="subhead">Effective Date: March 2026</p>

      <p>
        FORGE is an athletic performance platform operated by <strong>Madera Technologies LLC</strong>
        (DBA <strong>Zordon Technologies</strong>). This policy explains what information we collect,
        how we use it, and the choices you have.
      </p>

      <h2>1. Data We Collect</h2>
      <ul>
        <li><strong>Workout logs:</strong> training sessions, runs, lifts, distances, times, and related performance entries.</li>
        <li><strong>Health metrics:</strong> heart rate, recovery and readiness signals, and similar fitness measurements when you grant access.</li>
        <li><strong>Device data:</strong> app version, device model, operating system, and diagnostic events used for reliability and support.</li>
      </ul>

      <h2>2. How We Use Data</h2>
      <ul>
        <li>To provide core FORGE features including workout tracking, performance analysis, and progress insights.</li>
        <li>To improve stability, security, and user experience across devices.</li>
        <li>To respond to support requests and operational communications.</li>
      </ul>

      <h2>3. Data Sharing</h2>
      <p>
        We do <strong>not</strong> sell personal data to third parties. We only share information when required to
        operate the service (for example, infrastructure providers under confidentiality obligations) or when
        required by law.
      </p>

      <h2>4. Data Retention</h2>
      <p>
        We retain data while your account is active and as needed to provide FORGE services. You may request
        deletion of your account and associated data by contacting us.
      </p>

      <h2>5. Your Rights</h2>
      <p class="muted">
        Depending on your jurisdiction, you may have rights to access, correct, delete, or export your data,
        and to withdraw consent for optional health data integrations.
      </p>
      <p>
        To exercise these rights, contact us at
        <a href="mailto:hello@zordontechnologies.com">hello@zordontechnologies.com</a>.
      </p>

      <h2>6. Contact Information</h2>
      <p>
        Madera Technologies LLC (Zordon Technologies)<br />
        Email: <a href="mailto:hello@zordontechnologies.com">hello@zordontechnologies.com</a>
      </p>

      <footer>&copy; 2026 Madera Technologies LLC. All rights reserved.</footer>
    </div>
  </div>
</body>
</html>`;

router.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(PRIVACY_HTML);
});

module.exports = router;

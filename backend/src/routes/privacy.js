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
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f1117;
      color: #e2e8f0;
      line-height: 1.7;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
      padding: 60px 24px 80px;
    }
    .logo {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 48px;
    }
    .logo-mark {
      width: 36px;
      height: 36px;
      background: #EAB308;
      border-radius: 8px;
    }
    .logo-text {
      font-size: 22px;
      font-weight: 800;
      color: #ffffff;
      letter-spacing: -0.5px;
    }
    h1 {
      font-size: 32px;
      font-weight: 800;
      color: #ffffff;
      margin-bottom: 8px;
      letter-spacing: -0.5px;
    }
    .updated {
      color: #64748b;
      font-size: 14px;
      margin-bottom: 40px;
    }
    h2 {
      font-size: 18px;
      font-weight: 700;
      color: #ffffff;
      margin: 36px 0 12px;
    }
    p {
      color: #94a3b8;
      margin-bottom: 16px;
    }
    ul {
      color: #94a3b8;
      padding-left: 24px;
      margin-bottom: 16px;
    }
    ul li {
      margin-bottom: 8px;
    }
    a {
      color: #EAB308;
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
    .card {
      background: #171c27;
      border: 1px solid #2c3345;
      border-radius: 12px;
      padding: 24px;
      margin-top: 40px;
    }
    .card p {
      margin: 0;
    }
    hr {
      border: none;
      border-top: 1px solid #2c3345;
      margin: 40px 0;
    }
    footer {
      color: #64748b;
      font-size: 13px;
      margin-top: 48px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">
      <div class="logo-mark"></div>
      <span class="logo-text">FORGE</span>
    </div>

    <h1>Privacy Policy</h1>
    <p class="updated">Last updated: March 3, 2026</p>

    <p>
      FORGE is operated by <strong>Madera Technologies LLC</strong> (also doing business as Zordon Technologies),
      a company incorporated in Delaware, USA. This Privacy Policy explains how we collect, use, and protect
      your personal information when you use the FORGE application and website at
      <a href="https://forgeathlete.app">forgeathlete.app</a>.
    </p>

    <h2>1. Information We Collect</h2>
    <p>We collect the following categories of information:</p>
    <ul>
      <li><strong>Account information:</strong> Name, email address, and password (stored as a bcrypt hash).</li>
      <li><strong>Health and fitness data:</strong> Workout logs (runs, lifts), distance, duration, heart rate, steps, active energy, and heart rate variability — only when you explicitly grant permission.</li>
      <li><strong>Device data:</strong> Device type, operating system version, and app version for crash reporting and compatibility purposes.</li>
      <li><strong>Usage data:</strong> Screens visited, features used, and errors encountered — used to improve the app experience.</li>
    </ul>

    <h2>2. How We Use Your Information</h2>
    <ul>
      <li>To provide, maintain, and improve the FORGE application and its features.</li>
      <li>To sync your health and fitness data with connected services (Apple Health, Google Health Connect, Garmin Connect) — only with your explicit consent.</li>
      <li>To personalize your training plans, performance snapshots, and progress tracking.</li>
      <li>To send service-related communications (e.g., account verification, support responses).</li>
      <li>To comply with legal obligations.</li>
    </ul>

    <h2>3. Health Data</h2>
    <p>
      FORGE requests access to health and fitness data (steps, heart rate, workouts, etc.) solely to provide
      training and performance insights within the app. We do not sell, share, or use health data for advertising.
      Health data is stored on our secure servers and is never shared with third parties without your explicit consent.
    </p>
    <p>
      If you connect a third-party service (such as Garmin Connect), you authorize that service to share
      data with FORGE under the terms of that service's developer program. You may revoke this access at
      any time from your FORGE profile settings.
    </p>

    <h2>4. Data Sharing</h2>
    <p>We do not sell your personal information. We may share data with:</p>
    <ul>
      <li><strong>Service providers:</strong> Infrastructure and hosting providers (e.g., Railway) that process data on our behalf under strict confidentiality agreements.</li>
      <li><strong>Legal authorities:</strong> When required by law, court order, or to protect the rights and safety of our users.</li>
    </ul>

    <h2>5. Data Retention</h2>
    <p>
      We retain your account and fitness data for as long as your account is active. You may request deletion
      of your account and all associated data at any time by contacting us at
      <a href="mailto:privacy@forgeathlete.app">privacy@forgeathlete.app</a>.
      Upon request, we will delete your data within 30 days, except where retention is required by law.
    </p>

    <h2>6. Security</h2>
    <p>
      We implement industry-standard security measures including encrypted data transmission (TLS),
      bcrypt password hashing, JWT-based authentication, and rate limiting. No system is 100% secure;
      we encourage you to use a strong, unique password for your FORGE account.
    </p>

    <h2>7. Children's Privacy</h2>
    <p>
      FORGE is not directed at children under the age of 13. We do not knowingly collect personal
      information from children under 13. If you believe we have inadvertently collected such information,
      please contact us immediately.
    </p>

    <h2>8. Your Rights</h2>
    <p>Depending on your location, you may have the right to:</p>
    <ul>
      <li>Access, correct, or delete your personal data.</li>
      <li>Withdraw consent for health data processing at any time.</li>
      <li>Request a portable copy of your data.</li>
      <li>Lodge a complaint with your local data protection authority.</li>
    </ul>
    <p>To exercise any of these rights, contact us at <a href="mailto:privacy@forgeathlete.app">privacy@forgeathlete.app</a>.</p>

    <h2>9. Changes to This Policy</h2>
    <p>
      We may update this Privacy Policy from time to time. We will notify you of material changes by
      posting the new policy on this page with an updated date. Continued use of FORGE after changes
      constitutes acceptance of the updated policy.
    </p>

    <h2>10. Contact Us</h2>
    <p>For privacy-related questions or requests:</p>
    <div class="card">
      <p>
        <strong style="color:#ffffff">Madera Technologies LLC</strong><br />
        DBA Zordon Technologies<br />
        Registered in Delaware, USA<br /><br />
        Email: <a href="mailto:privacy@forgeathlete.app">privacy@forgeathlete.app</a><br />
        Website: <a href="https://forgeathlete.app">forgeathlete.app</a>
      </p>
    </div>

    <hr />
    <footer>
      &copy; 2026 Madera Technologies LLC &mdash; All rights reserved.
    </footer>
  </div>
</body>
</html>`;

router.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(PRIVACY_HTML);
});

module.exports = router;

const router = require('express').Router();
const auth = require('../middleware/auth');
const { requireDiagnosticsAdmin } = require('./diagnostics');
const {
  feedbackSummary,
  listHumanFeedback,
  listImageRequests,
  updateHumanFeedback,
  updateImageRequest,
} = require('../lib/feedbackWorkflow');

function sendWorkflowError(res, label, err) {
  if (err.code === 'INVALID_FEEDBACK_WORKFLOW') {
    return res.status(400).json({ error: err.message });
  }
  console.error(`[admin/feedback] ${label}:`, err.message);
  return res.status(500).json({ error: 'Could not update the feedback workflow.' });
}

router.get('/summary', auth, requireDiagnosticsAdmin, async (_req, res) => {
  try {
    res.json(await feedbackSummary());
  } catch (err) {
    console.error('[admin/feedback] summary failed:', err.message);
    res.status(500).json({ error: 'Could not load feedback summary.' });
  }
});

router.get('/image-requests', auth, requireDiagnosticsAdmin, async (req, res) => {
  try {
    const requests = await listImageRequests({ statuses: req.query.status, limit: req.query.limit });
    res.json({ requests });
  } catch (err) {
    sendWorkflowError(res, 'image request list failed', err);
  }
});

router.patch('/image-requests/:id', auth, requireDiagnosticsAdmin, async (req, res) => {
  try {
    const request = await updateImageRequest(req.params.id, req.body || {});
    if (!request) return res.status(404).json({ error: 'Image request not found.' });
    res.json({ request });
  } catch (err) {
    sendWorkflowError(res, 'image request update failed', err);
  }
});

router.get('/', auth, requireDiagnosticsAdmin, async (req, res) => {
  try {
    const feedback = await listHumanFeedback({ statuses: req.query.status, limit: req.query.limit });
    res.json({ feedback });
  } catch (err) {
    sendWorkflowError(res, 'list failed', err);
  }
});

router.patch('/:id', auth, requireDiagnosticsAdmin, async (req, res) => {
  try {
    const feedback = await updateHumanFeedback(req.params.id, req.body || {});
    if (!feedback) return res.status(404).json({ error: 'Feedback not found.' });
    res.json({ feedback });
  } catch (err) {
    sendWorkflowError(res, 'update failed', err);
  }
});

module.exports = router;

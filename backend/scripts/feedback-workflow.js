const { pool } = require('../src/db');
const {
  feedbackSummary,
  listHumanFeedback,
  listImageRequests,
  updateHumanFeedback,
  updateImageRequest,
} = require('../src/lib/feedbackWorkflow');

function decodePayload(encoded) {
  if (!encoded) throw new Error('A base64url JSON payload is required.');
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
}

async function main() {
  const [command, value] = process.argv.slice(2);
  switch (command) {
    case 'summary':
      return feedbackSummary();
    case 'list-human':
      return { feedback: await listHumanFeedback({ statuses: value }) };
    case 'list-images':
      return { requests: await listImageRequests({ statuses: value }) };
    case 'update-human': {
      const payload = decodePayload(value);
      const feedback = await updateHumanFeedback(payload.id, payload);
      if (!feedback) throw new Error('Feedback not found.');
      return { feedback };
    }
    case 'update-image': {
      const payload = decodePayload(value);
      const request = await updateImageRequest(payload.id, payload);
      if (!request) throw new Error('Image request not found.');
      return { request };
    }
    default:
      throw new Error('Usage: feedback-workflow.js summary | list-human [statuses] | list-images [statuses] | update-human <base64url-json> | update-image <base64url-json>');
  }
}

main()
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((err) => {
    console.error(`[feedback-workflow] ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

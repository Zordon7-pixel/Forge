const MAX_ACTIVITY_PHOTOS = 4;
const MAX_PHOTO_DATA_LENGTH = 1000000;
const PHOTO_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const PUBLIC_ACTIVITY_TYPES = new Set(['feed', 'post', 'community_post']);

function hasExpectedSignature(buffer, mimeType) {
  if (mimeType === 'image/jpeg') {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    return buffer.length >= 8
      && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  return buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
}

function validatePhotoPayload(payload = {}) {
  const data = payload?.data;
  const mimeType = payload?.mime_type;

  if (typeof data !== 'string' || !data) return { error: 'Photo data is required' };
  if (data.length > MAX_PHOTO_DATA_LENGTH) return { error: 'Photo too large - must be under 1MB' };
  if (typeof mimeType !== 'string' || !PHOTO_MIME_TYPES.has(mimeType)) return { error: 'Invalid image type' };

  const prefix = `data:${mimeType};base64,`;
  if (!data.startsWith(prefix)) return { error: 'Photo data does not match its image type' };

  const encoded = data.slice(prefix.length);
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    return { error: 'Photo data is invalid' };
  }

  const decoded = Buffer.from(encoded, 'base64');
  if (!hasExpectedSignature(decoded, mimeType)) return { error: 'Photo data does not match its image type' };

  return { data, mimeType };
}

function defaultMediaVisibility(activityType) {
  return PUBLIC_ACTIVITY_TYPES.has(activityType) ? 'public' : 'private';
}

module.exports = {
  MAX_ACTIVITY_PHOTOS,
  MAX_PHOTO_DATA_LENGTH,
  PHOTO_MIME_TYPES,
  defaultMediaVisibility,
  validatePhotoPayload,
};

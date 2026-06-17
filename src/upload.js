// Auto-upload extracted DOCX images to the CMS media store and return the
// hosted URL, so the formatter can rewrite ![](shikho-img:imageN.png) ->
// ![](https://res.cloudinary.com/.../xxxxx.png) exactly like the manual flow.
//
// The CMS delivers images from Cloudinary (cloud:
// cross-border-education-technologies-pte-ltd). The most robust, CORS-friendly
// way to upload from the browser is Cloudinary's *unsigned* upload endpoint,
// which needs an unsigned upload preset enabled on that account.
//
// Confirmed from a live CMS upload (Cloudinary Upload Widget): the POST to
//   https://api.cloudinary.com/v1_1/<cloud>/auto/upload
// carries only { upload_preset, source, file } — i.e. an UNSIGNED preset
// (no api_key/signature/timestamp, credentials: omit), so the same call runs
// straight from this app's browser with CORS, no auth token needed.

export const IMG_UPLOAD = {
  provider: 'cloudinary',                                  // 'cloudinary' | 'none'
  cloudName: 'cross-border-education-technologies-pte-ltd', // from the CMS image URLs
  uploadPreset: 'cross-border-education-technologies-pte-ltd', // unsigned preset used by CMS
};

export function isUploadConfigured() {
  return IMG_UPLOAD.provider === 'cloudinary' &&
    !!IMG_UPLOAD.cloudName && !!IMG_UPLOAD.uploadPreset;
}

// Upload one image. `img` = { bytes: Uint8Array, contentType }. Returns the URL.
export async function uploadImage(img, filename) {
  if (IMG_UPLOAD.provider !== 'cloudinary') {
    throw new Error('Image upload provider not configured.');
  }
  // /auto/upload (matches the CMS widget) handles any image type and returns a
  // res.cloudinary.com/.../image/upload/v.../<id>.png delivery URL.
  const url = `https://api.cloudinary.com/v1_1/${IMG_UPLOAD.cloudName}/auto/upload`;
  const fd = new FormData();
  fd.append('upload_preset', IMG_UPLOAD.uploadPreset);
  fd.append('source', 'uw');
  fd.append('file', new Blob([img.bytes], { type: img.contentType || 'image/png' }), filename || 'image.png');
  const res = await fetch(url, { method: 'POST', body: fd });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`Cloudinary upload failed (${res.status}): ${detail}`);
  }
  const json = await res.json();
  const out = json.secure_url || json.url;
  if (!out) throw new Error('Upload succeeded but no URL in response.');
  return out;
}

// Upload many (deduplicated by basename). Returns { basename: url }.
// onProgress(done, total, basename) is called after each upload.
export async function uploadImages(needed, images, onProgress) {
  const out = {};
  const names = [...needed].filter((n) => images[n]);
  let done = 0;
  for (const n of names) {
    out[n] = await uploadImage(images[n], n);
    onProgress && onProgress(++done, names.length, n);
  }
  return out;
}

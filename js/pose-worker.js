// Runs MediaPipe pose detection in a background thread so the game's
// rendering never waits on the model. (Classic worker: MediaPipe's loader
// needs importScripts, and Chrome allows dynamic import() here.)

let landmarker = null;

self.onmessage = async e => {
  const msg = e.data;
  if (msg.type === 'init') {
    try {
      const { PoseLandmarker, FilesetResolver } = await import(`${msg.mpUrl}/vision_bundle.mjs`);
      const fileset = await FilesetResolver.forVisionTasks(`${msg.mpUrl}/wasm`);
      const opts = (model, delegate) => ({
        baseOptions: { modelAssetPath: msg.models[model], delegate },
        runningMode: 'VIDEO',
        numPoses: msg.numPoses || 1,
        minPoseDetectionConfidence: 0.6,
        minPosePresenceConfidence: 0.6,
        minTrackingConfidence: 0.6,
        ...(delegate === 'GPU' && typeof OffscreenCanvas !== 'undefined' ? { canvas: new OffscreenCanvas(1, 1) } : {}),
      });
      let name = null;
      for (const [model, delegate] of [['full', 'GPU'], ['lite', 'GPU'], ['full', 'CPU'], ['lite', 'CPU']]) {
        try {
          landmarker = await PoseLandmarker.createFromOptions(fileset, opts(model, delegate));
          name = `${model}/${delegate}`;
          break;
        } catch (err) {
          console.warn(`[pose worker] ${model}/${delegate} failed`, err);
        }
      }
      if (!landmarker) throw new Error('no model could be loaded');
      self.postMessage({ type: 'ready', model: name });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err?.message || err) });
    }
    return;
  }

  if (msg.type === 'options') {
    try { await landmarker?.setOptions({ numPoses: msg.numPoses }); } catch (err) { console.warn('[pose worker] setOptions failed', err); }
    return;
  }

  if (msg.type === 'frame') {
    const { bitmap, ts } = msg;
    let lms = [];
    try {
      const res = landmarker.detectForVideo(bitmap, ts);
      lms = (res.landmarks || []).map(p => p.map(q => [q.x, q.y, q.visibility ?? 1]));
    } catch (err) {
      console.warn('[pose worker] detect failed', err);
    }
    bitmap.close();
    self.postMessage({ type: 'result', lms, ts });
  }
};

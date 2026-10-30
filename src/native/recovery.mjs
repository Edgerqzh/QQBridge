/** A lost transport invalidates an initialized kernel. Do not recreate that
 * kernel in the same process or replay an application send. The host restarts
 * the native worker after a grace period; authentication failures require QR. */
export function createRecoveryController({ requestRestart = () => {}, onChange = () => {}, canRestore = () => false, graceMs = 15000 }) {
  if (!Number.isInteger(graceMs) || graceMs < 1) throw new TypeError('Invalid recovery grace period.');
  let timer, stopped = false, requested = false, seenOnline = false;
  let state = { phase: 'idle', reason: null, last_online_at: null, restart_requested: false };
  function change(value) { state = { ...state, ...value }; onChange(); }
  function restart(mode, reason) {
    if (stopped || requested) return;
    requested = true; clearTimeout(timer);
    change({ phase: mode === 'manual' ? 'manual_required' : 'restart_requested', reason, restart_requested: true });
    // Always leave the native callback before shutdown/host notification.
    setImmediate(() => { if (!stopped) requestRestart({ mode, reason }); });
  }
  return {
    observe({ online, reason = 'session_offline', sessionReady = false }) {
      if (stopped || requested) return;
      if (online) {
        seenOnline = true; clearTimeout(timer); timer = null;
        if (state.phase !== 'online') change({ phase: 'online', reason: null, last_online_at: Math.floor(Date.now() / 1000) });
      } else if ((seenOnline || sessionReady) && !timer) {
        change({ phase: 'waiting', reason });
        timer = setTimeout(() => { timer = null; restart(canRestore() ? 'automatic' : 'manual', reason); }, graceMs);
        timer.unref?.();
      }
    },
    authenticationRequired(reason = 'authentication_required') { restart('manual', reason); },
    status: () => ({ ...state }),
    stop() { stopped = true; clearTimeout(timer); },
  };
}

/** Restart budget lives in the supervisor, outside the worker being restarted.
 * Six native restarts per ten minutes, with capped exponential backoff. */
export function createRestartBudget({ limit = 6, windowMs = 600000, baseMs = 1000, maxMs = 30000, now = Date.now } = {}) {
  let attempts = [];
  return {
    next() {
      const stamp = now(); attempts = attempts.filter(at => stamp - at < windowMs);
      if (attempts.length >= limit) return { manual: true, delayMs: 0, attempts: attempts.length };
      const delayMs = Math.min(maxMs, baseMs * 2 ** attempts.length);
      attempts.push(stamp); return { manual: false, delayMs, attempts: attempts.length };
    },
  };
}

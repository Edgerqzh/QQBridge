/** Original, partial OneBot 11 action dispatcher. No QQ transport is emulated. */
const ONLINE_ACTIONS = new Set([
  'send_private_msg', 'send_group_msg', 'send_msg', 'delete_msg', 'get_msg',
  'get_forward_msg', 'send_like', 'set_group_kick', 'set_group_ban',
  'set_group_anonymous_ban', 'set_group_whole_ban', 'set_group_admin',
  'set_group_anonymous', 'set_group_card', 'set_group_name', 'set_group_leave',
  'set_group_special_title', 'set_friend_add_request', 'set_group_add_request',
  'get_stranger_info', 'get_friend_list', 'get_group_info',
  'get_group_member_info', 'get_group_member_list', 'get_group_msg_history', 'get_friend_info', 'get_friend_msg_history', 'get_private_msg_history', 'upload_private_file',
  'get_group_honor_info', 'get_cookies', 'get_csrf_token', 'get_credentials',
]);

export function failure(retcode, message, echo) {
  return { status: 'failed', retcode, data: null, message, ...(echo === undefined ? {} : { echo }) };
}

export function publicStatus(backend) {
  try {
    const status = backend.status();
    return { online: status?.online === true, good: status?.good === true };
  } catch {
    return { online: false, good: false };
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function createActionDispatcher({ backend, appName = 'QQBridge', appVersion = '0.1.0', requestTimeoutMs = 15000 }) {
  if (!backend || typeof backend.call !== 'function' || typeof backend.status !== 'function') {
    throw new TypeError('backend must implement call(action, params) and status()');
  }
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new TypeError('requestTimeoutMs must be positive');
  }

  return async function dispatch(request) {
    const echo = isObject(request) ? request.echo : undefined;
    if (!isObject(request) || typeof request.action !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(request.action)) {
      return failure(1400, 'action must be a valid action name', echo);
    }
    const params = request.params === undefined ? {} : request.params;
    if (!isObject(params)) return failure(1400, 'params must be a JSON object', echo);

    const { action } = request;
    try {
      let data;
      if (action === 'get_version_info') {
        data = { app_name: appName, app_version: appVersion, protocol_version: 'v11' };
      } else if (action === 'get_status') {
        data = publicStatus(backend);
      } else {
        if (ONLINE_ACTIONS.has(action) && !publicStatus(backend).online) {
          return failure(1503, 'QQ backend is offline; no message was sent', echo);
        }
        let timer;
        try {
          data = await Promise.race([
            Promise.resolve().then(() => backend.call(action, params)),
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                const error = new Error('QQ operation timed out; delivery outcome is unknown');
                error.retcode = 1504;
                reject(error);
              }, requestTimeoutMs);
              timer.unref?.();
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
      return { status: 'ok', retcode: 0, data: data ?? null, ...(echo === undefined ? {} : { echo }) };
    } catch (error) {
      const exposed = Number.isInteger(error?.retcode) && error.retcode > 0;
      return failure(exposed ? error.retcode : 1500, exposed ? String(error.publicMessage ?? error.message ?? 'QQ operation failed') : 'QQ backend operation failed', echo);
    }
  };
}

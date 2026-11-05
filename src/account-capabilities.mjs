export const PROFILE_ACTIONS = Object.freeze(['set_qq_profile', 'set_self_longnick', 'set_qq_avatar', 'set_online_status']);
export const QZONE_ACTIONS = Object.freeze(['get_cookies', 'get_credentials']);
export const isAccountCapability = action => PROFILE_ACTIONS.includes(action) || QZONE_ACTIONS.includes(action);

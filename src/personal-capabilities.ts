/** Official Personal API coverage verified against the published OpenAPI. */
export const PERSONAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'get_garmin_activities', 'get_garmin_sleep', 'get_garmin_steps',
  'get_garmin_heart_rate', 'get_garmin_weight', 'get_garmin_profile',
  'download_garmin_activity_fit', 'get_running_skill_advice',
  'get_garmin_spo2', 'get_garmin_respiration', 'get_garmin_hrv',
  'get_garmin_hrv_summaries', 'get_garmin_stress', 'get_garmin_stress_summaries',
  'get_garmin_body_battery',
])

export const PERSONAL_PROVIDER_INSTRUCTIONS =
  '\nThis connection uses the official Garmin Personal API with a user-configured API Key. ' +
  'It provides supported read operations only. Respiration and daily stress may contain summaries, ' +
  'not full-day time series. Preserve that distinction. API Key or access errors require checking ' +
  'the key in local settings; do not start browser SSO or switch to another account/provider. ' +
  'Mainland account availability has not been verified successfully. An empty result is not zero.'

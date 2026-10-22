/** Shared DSH/MCP contract for raw recovery and training metrics. */
export const HEALTH_TOOLS = [
  { name: 'get_garmin_spo2', method: 'getSpO2Data', kind: 'daily', description: 'Get daily Garmin blood oxygen (SpO2), preserving all available readings and returned fields. Data availability depends on the device and recorded measurements.' },
  { name: 'get_garmin_respiration', method: 'getRespirationData', kind: 'daily', description: 'Get daily Garmin respiration, preserving all available breathing-rate readings and returned fields. Personal API returns explicitly labeled daily summaries, not a full-day curve. Data availability depends on the device and recorded measurements.' },
  { name: 'get_garmin_hrv', method: 'getHrvData', kind: 'daily', description: 'Get daily Garmin HRV status, baseline and every overnight reading.' },
  { name: 'get_garmin_hrv_summaries', method: 'getHrvSummaries', kind: 'range', description: 'Get Garmin daily HRV summaries over an inclusive date range. These are summaries, not overnight readings.' },
  { name: 'get_garmin_stress', method: 'getStressData', kind: 'daily', description: 'Get daily Garmin stress with the complete available response. Browser connections may include stress and Body Battery time series; Personal API provides daily stress summaries.' },
  { name: 'get_garmin_stress_summaries', method: 'getStressSummaries', kind: 'range', description: 'Get daily Garmin stress summaries over an inclusive date range.' },
  { name: 'get_garmin_body_battery', method: 'getBodyBattery', kind: 'range', description: 'Get Garmin Body Battery reports and their full time series over an inclusive date range.' },
  { name: 'get_garmin_training_readiness', method: 'getTrainingReadiness', kind: 'daily', description: 'Get all Garmin training readiness snapshots and recovery factors for a date.' },
  { name: 'get_garmin_daily_training_status', method: 'getDailyTrainingStatus', kind: 'daily', description: 'Get daily Garmin training status and acute/chronic load, preserving every returned device.' },
  { name: 'get_garmin_training_status', method: 'getTrainingStatus', kind: 'daily', description: 'Get aggregated Garmin training status, VO2 max and load data for a date.' },
  { name: 'get_garmin_training_load_balance', method: 'getTrainingLoadBalance', kind: 'daily', description: 'Get Garmin four-week training load balance ending on a date, preserving every device.' },
  { name: 'get_garmin_max_metrics', method: 'getMaxMetrics', kind: 'daily', description: 'Get Garmin max metrics, including available VO2 max data, for a date.' },
  { name: 'get_garmin_max_metrics_range', method: 'getMaxMetricsRange', kind: 'range', description: 'Get Garmin max metrics over an inclusive date range with one native range request.' },
  { name: 'get_garmin_race_predictions', method: 'getRacePredictions', kind: 'latest', description: 'Get the latest Garmin race predictions for the selected authenticated account.' },
  { name: 'get_garmin_race_predictions_range', method: 'getRacePredictionsRange', kind: 'raceRange', description: 'Get Garmin race prediction history by day or month. Maximum calendar span is 366 days.' },
] as const

/** SDK 1.7.0 supplies these 13 dedicated methods; the two wellness reads use its HTTP transport. */
export const SDK_HEALTH_METHODS = HEALTH_TOOLS
  .filter(definition => definition.method !== 'getSpO2Data' && definition.method !== 'getRespirationData')
  .map(definition => definition.method)

export type HealthMetricMethod = typeof HEALTH_TOOLS[number]['method']
export interface HealthMetricArgs {
  date?: string
  startDate?: string
  endDate?: string
  aggregation?: 'daily' | 'monthly'
}

export interface GarminRecoveryDataClient {
  getSpO2Data(date: string): Promise<unknown>
  getRespirationData(date: string): Promise<unknown>
  getHrvData(date: string): Promise<unknown>
  getHrvSummaries(startDate: string, endDate: string): Promise<unknown>
  getStressData(date: string): Promise<unknown>
  getStressSummaries(startDate: string, endDate: string): Promise<unknown>
  getBodyBattery(startDate: string, endDate?: string): Promise<unknown>
  getTrainingReadiness(date: string): Promise<unknown>
  getDailyTrainingStatus(date: string): Promise<unknown>
  getTrainingStatus(date: string): Promise<unknown>
  getTrainingLoadBalance(date: string): Promise<unknown>
  getMaxMetrics(date: string): Promise<unknown>
  getMaxMetricsRange(startDate: string, endDate: string): Promise<unknown>
  getRacePredictions(): Promise<unknown>
  getRacePredictionsRange(startDate: string, endDate: string, aggregation?: 'daily' | 'monthly'): Promise<unknown>
}

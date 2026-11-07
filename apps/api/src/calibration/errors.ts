/** Calibration errors carry only fixed public messages, never provider/DB details. */
export class CalibrationError extends Error {
 constructor(readonly code:string,message:string,readonly statusCode=503,readonly retryable=false){super(message);this.name='CalibrationError';}
}
export const invalidResponse=()=>new CalibrationError('CALIBRATION_INVALID_RESPONSE','The calibration result could not be verified. Retry with the same request key.',502,true);

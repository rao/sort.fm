import {PersistenceError,type Transaction} from './client';
/** Optional migration: legacy calibration/review remains usable before 015. */
export async function batchStorageReady(tx:Transaction){const [r]=await tx`SELECT to_regclass(current_schema()||'.calibration_batches') IS NOT NULL AS ready`;return r.ready as boolean;}
export async function reservedCalibrationTrackIds(tx:Transaction,userId:string):Promise<string[]>{
 if(!await batchStorageReady(tx))return [];
 return (await tx`SELECT track_id FROM calibration_batch_items WHERE user_id=${userId}`).map((r:any)=>r.track_id);
}
export async function assertNotBatchReserved(tx:Transaction,userId:string,trackId:string){
 if(!await batchStorageReady(tx))return;
 if((await tx`SELECT 1 FROM calibration_batch_items WHERE user_id=${userId} AND track_id=${trackId}`).length)throw new PersistenceError('BATCH_TRACK_RESERVED');
}
export async function batchExposure(tx:Transaction,userId:string,exposureId:string){
 if(!await batchStorageReady(tx))return null;
 return (await tx`SELECT b.* FROM calibration_batch_items b JOIN calibration_batch_exposures e USING(user_id,batch_item_id) WHERE e.user_id=${userId} AND e.exposure_id=${exposureId}`)[0]??null;
}

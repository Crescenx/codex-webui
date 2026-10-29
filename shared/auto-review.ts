import type { Notice, Obj } from './protocol.ts';
export type AutoReviewFailure={id:string;turnId:string;reason:string;kind:'error'|'denied'};
const record=(v:unknown):Obj=>v&&typeof v==='object'&&!Array.isArray(v)?v as Obj:{};
// Consume native review events only; ordinary model/tool errors must not suggest bypass.
export function autoReviewFailure(n:Notice):AutoReviewFailure|undefined{
 if(n.method!=='item/autoApprovalReview/completed')return;
 const p=n.params,review=record(p.review),result=record(p.result);
 if(typeof p.reviewId!=='string'||typeof p.turnId!=='string')return;
 if(review.status==='approved'||p.allowed===true)return;
 if(typeof result.error==='string'){
  if(/cancel|stale|interrupt/i.test(result.error))return;
  return {id:p.reviewId,turnId:p.turnId,reason:result.error,kind:'error'};
 }
 if(review.status==='timedOut'||review.status==='denied')return {id:p.reviewId,turnId:p.turnId,reason:typeof review.rationale==='string'?review.rationale:'自动审批未返回可用结果',kind:review.status==='timedOut'||review.riskLevel==null&&review.userAuthorization==null?'error':'denied'};
 if(record(result.assessment).outcome==='deny')return {id:p.reviewId,turnId:p.turnId,reason:String(record(result.assessment).rationale||'自动审批未放行此操作'),kind:'denied'};
}

import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { object, type Obj } from '../shared/protocol.ts';
import { HttpError } from './security.ts';

export function elicitationResponse(params: Obj, decision: string, answers: Obj): Obj {
  if (!['accept', 'decline', 'cancel'].includes(decision)) throw new HttpError(400, '无效表单操作');
  let content: Obj | null = null;
  if (decision === 'accept' && params.mode === 'form') {
    const validated = new AjvJsonSchemaValidator().getValidator(object(params.requestedSchema))(answers);
    if (!validated.valid) throw new HttpError(400, '请检查表单：' + validated.errorMessage);
    content = answers;
  }
  return { action: decision, content, _meta: null };
}

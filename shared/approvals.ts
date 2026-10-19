import type { Obj, PendingRequest } from './protocol.ts';

const record = (value: unknown): Obj => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
export function elicitationFields(params: Obj) {
  if (params.mode !== 'form') return null;
  const schema = record(params.requestedSchema), fields = Object.entries(record(schema.properties));
  if (schema.type !== 'object' || fields.length > 64 || fields.some(([, raw]) => !['string', 'number', 'integer', 'boolean', 'array'].includes(String(record(raw).type)))) return null;
  return fields.map(([name, raw]) => {
    const field = record(raw), options = field.type === 'array' ? record(field.items) : field;
    const choices = Array.isArray(options.enum) ? options.enum.map((value, i) => ({ value: String(value), title: String((options.enumNames as unknown[] | undefined)?.[i] ?? value) }))
      : Array.isArray(options.oneOf) ? options.oneOf.map(raw => ({ value: String(record(raw).const), title: String(record(raw).title ?? record(raw).const) })) : [];
    return { name, type: String(field.type), title: String(field.title || name), description: String(field.description || ''), choices, default: field.default };
  });
}
export function externalUrl(value: unknown): string | undefined {
  try { const url = new URL(String(value)); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}

export type ApprovalChoice = { id: string; label: string; description?: string; detail?: string; result: Obj };
export function approvalChoices(request: Pick<PendingRequest, 'method' | 'params' | 'windows'>): ApprovalChoice[] {

  if (request.method === 'mcpServer/elicitation/request') {
    const supported = request.params.mode === 'url' ? !!externalUrl(request.params.url) : !!elicitationFields(request.params);
    return (supported ? ['accept', 'decline', 'cancel'] : ['decline', 'cancel']).map(id => ({ id, label: id === 'accept' ? '提交' : id === 'decline' ? '拒绝' : '取消', result: { action: id, content: null, _meta: null } }));
  }
  const p = request.params, command = request.method === 'item/commandExecution/requestApproval';
  const permissions = request.method === 'item/permissions/requestApproval';
  const question = request.method === 'item/tool/requestUserInput';
  if (!command && !permissions && !question && request.method !== 'item/fileChange/requestApproval') return [];
  const offered = (command || request.method === 'item/fileChange/requestApproval') && Array.isArray(p.availableDecisions) ? p.availableDecisions : null;
  const choices: ApprovalChoice[] = [];
  const add = (id: string, label: string, decision: string | Obj, description?: string, detail?: string) => {
    if (offered && !offered.some(d => JSON.stringify(d) === JSON.stringify(decision))) return;
    const result = permissions
      ? { permissions: id === 'accept' || id === 'acceptForSession' ? p.permissions : {}, scope: id === 'acceptForSession' ? 'session' : 'turn' }
      : { decision };
    choices.push({ id, label, description, detail, result });
  };
  add('accept', question ? '提交回答' : permissions ? '本轮允许' : request.windows ? '允许本次 Windows 操作' : '单次允许', 'accept');
  if (!question) add('acceptForSession', '本会话允许', 'acceptForSession', permissions
    ? '本次列出的权限可用于当前会话的后续轮次。'
    : p.approvalScope==='identicalToolArguments' ? '此会话内仅记住工具名称和完全相同的参数；参数或权限范围改变后会再次询问。' : command ? '由 Codex 在当前会话内记住匹配的审批；其他命令仍可能询问。' : '当前会话内，对相同文件的后续修改不再询问。');
  const prefix = p.proposedExecpolicyAmendment;
  if (command && Array.isArray(prefix) && prefix.length && prefix.every(v => typeof v === 'string' && v.length)) {
    const shellScript=prefix.length>=3 && /(?:^|\/)(?:ba|z|da|k)?sh$/.test(prefix[0]) && /^-[a-z]*c[a-z]*$/.test(prefix[1]);
    add('rememberCommand', '允许并保存命令规则', { acceptWithExecpolicyAmendment: { execpolicy_amendment: prefix } },
      (shellScript?'此规则包含整段 shell 脚本；脚本内容变化后仍会再次询问。':'保存以下命令前缀到 Codex 规则，匹配此前缀的后续命令不再询问。') + '规则跨会话生效，也影响使用同一配置的 CLI。', JSON.stringify(prefix));
  }
  if (command && Array.isArray(p.proposedNetworkPolicyAmendments)) p.proposedNetworkPolicyAmendments.forEach((raw, i) => {
    const rule = raw as { host?: unknown; action?: unknown } | null;
    if (rule?.action === 'allow' && typeof rule.host === 'string' && rule.host) {
      const amendment = { host: rule.host, action: 'allow' };
      // JSON object key order is not part of the protocol.
      const decision = offered?.find(d => {
        const a = (d as { applyNetworkPolicyAmendment?: { network_policy_amendment?: typeof amendment } } | null)?.applyNetworkPolicyAmendment?.network_policy_amendment;
        return a?.host === amendment.host && a.action === amendment.action;
      }) as Obj | undefined;
      add('rememberHost:' + i, '允许并保存主机规则', decision || { applyNetworkPolicyAmendment: { network_policy_amendment: amendment } },
        '保存此主机的网络允许规则，跨会话生效，也影响使用同一配置的 CLI。', rule.host);
    }
  });
  add('decline', '拒绝', 'decline'); add('cancel', '取消', 'cancel');
  return choices;
}

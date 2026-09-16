import { createInterface } from 'node:readline';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';

export function watchdogLaunch(endpoint: string, token: string) {
  return {
    args: [
      '-c', `mcp_servers.viewer_watchdogs.command=${JSON.stringify(process.execPath)}`,
      '-c', `mcp_servers.viewer_watchdogs.args=${JSON.stringify([fileURLToPath(import.meta.url)])}`,
      // This built-in server manages local schedules. Executed checks retain native command/file approvals.
      '-c', 'mcp_servers.viewer_watchdogs.default_tools_approval_mode="approve"',
      '-c', 'mcp_servers.viewer_watchdogs.env_vars=["VIEWER_WATCHDOG_URL","VIEWER_WATCHDOG_TOKEN"]',
    ],
    env: { VIEWER_WATCHDOG_URL: endpoint, VIEWER_WATCHDOG_TOKEN: token },
  };
}

const string = { type: 'string' }, id = { id: string }, revision = { revision: { type: 'integer', minimum: 1 } };
const schema = (properties: object, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const time = { ...string, pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', description: 'HH:mm in the backend timezone returned by watchdog_list' };
const schedule = { description: 'Calendar schedule in the backend local timezone. Each date has one execution time. Read watchdog_list for the timezone.', oneOf: [
  schema({ kind: { const: 'daily' }, everyDays: { type: 'integer', minimum: 1, maximum: 365, description: '1 means daily; 2 means every two calendar days' }, startDate: { ...string, description: 'YYYY-MM-DD; anchor date, preserved across runs and resume' }, time }, ['kind', 'everyDays', 'startDate', 'time']),
  schema({ kind: { const: 'weekly' }, weekdays: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 }, minItems: 1, maxItems: 7, uniqueItems: true, description: 'ISO weekdays: Monday=1, Sunday=7' }, time }, ['kind', 'weekdays', 'time']),
  schema({ kind: { const: 'once' }, at: { ...string, description: 'YYYY-MM-DDTHH:mm in the backend local timezone, without offset. New or changed appointments must be in the future.' } }, ['kind', 'at']),
] };
const config = { name: { ...string, description: 'Short descriptive name' }, prompt: { ...string, description: 'Write durable instructions using this conversation: objective, remote host/job IDs, inspection commands or paths, evidence for severe errors, exact authorized stop/repair scope, limits, and completion criteria. Include enough context to run later. Never invent missing critical identifiers or permissions.' }, intervalMinutes: { type: 'integer', minimum: 1, maximum: 525600 }, schedule, model: string, effort: { type: ['string','null'] } };
const scheduledSchema = (properties: object, required: string[]) => ({ ...schema(properties, required), oneOf: [{ required: ['intervalMinutes'] }, { required: ['schedule'] }] });
export const watchdogTools = [
  { name: 'watchdog_create', description: 'Create and enable a persistent scheduled watchdog in THIS conversation, only when the user explicitly asks for scheduled work (including one-off work). Author its prompt from the conversation; ask for missing critical details. Supply exactly one of intervalMinutes or schedule. First run is after the interval or at the next calendar appointment, with the current effective model/effort unless supplied. Multiple independent watchdogs are supported. Runs wait for this conversation to become idle and require the backend and machine to be running. Missed times coalesce into one catch-up. Do not create a goal. Return the saved task for inspection and editing.', inputSchema: scheduledSchema(config, ['name','prompt']) },
  { name: 'watchdog_list', description: 'Read watchdog configurations, state, revision and the backend timeZone for THIS conversation.', inputSchema: schema({}, []) },
  { name: 'watchdog_update', description: 'Update a watchdog only at the user\'s request. First read its latest revision. Supply the complete configuration, with exactly one of intervalMinutes or schedule. A running check keeps its snapshot; edits affect subsequent checks. Changing a schedule replaces its previous timing rule.', inputSchema: scheduledSchema({ ...id, ...revision, ...config }, ['id','revision','name','prompt','model','effort']) },
  { name: 'watchdog_control', description: 'At the user\'s request, pause, resume, run_now, or delete a watchdog in THIS conversation. Read watchdog_list first for the latest revision. Delete is also allowed during a scheduled check; other management actions are not. Pause/delete cancel future checks and preserve history without interrupting the active turn. Resume waits one interval or until the next calendar appointment; an unfinished overdue one-off runs when idle. A completed one-off requires a changed future time before resume, or an explicit run_now to repeat it. run_now waits for idle; it resets fixed-interval timing but preserves recurring calendar anchors.', inputSchema: schema({ ...id, ...revision, action: { enum: ['pause','resume','run_now','delete'] } }, ['id','revision','action']) },
  { name: 'watchdog_report', description: 'Required at the end of a scheduled watchdog turn, including after deletion. Submit runId and outcome only: continue schedules the next recurring check, complete ends the entire monitoring objective, needs_input pauses for user action. A successful one-off ends even with continue. Write findings in the conversation; do not duplicate them here. The outcome is provisional until native success; failures override it. summary is optional for compatibility.', inputSchema: schema({ runId: string, outcome: { enum: ['continue','complete','needs_input'] }, summary: string }, ['runId','outcome']) },
];

async function call(params: Record<string, unknown>) {
  const endpoint = process.env.VIEWER_WATCHDOG_URL, token = process.env.VIEWER_WATCHDOG_TOKEN;
  if (!endpoint || !token) throw new Error('Watchdog bridge is not configured');
  // Direct loopback HTTP deliberately ignores proxy environment variables.
  return new Promise<unknown>((resolve,reject) => {
    const req = request(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 30000 }, res => {
      let data=''; res.setEncoding('utf8'); res.on('data', part => { data+=part; if (data.length>2_000_000) req.destroy(new Error('Response too large')); });
      res.on('end', () => { try { const value=JSON.parse(data); if (res.statusCode!==200) reject(new Error(value.error || 'Watchdog request failed')); else resolve(value); } catch(error) { reject(error); } });
      res.on('error',reject);
    });
    req.on('error',reject); req.on('timeout',()=>req.destroy(new Error('Watchdog request timed out; read state before retrying'))); req.end(JSON.stringify(params));
  });
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const lines=createInterface({input:process.stdin});
  lines.on('line', line => { void (async()=>{
    let msg: { id?: unknown; method?: string; params?: Record<string,unknown> };
    try { msg=JSON.parse(line); } catch { return; }
    if (msg.id===undefined) return;
    const send=(result:unknown)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result})+'\n');
    if(msg.method==='initialize') { send({protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'viewer_watchdogs',version:'1.0.0'},instructions:'Use watchdog_create when the user explicitly requests recurring or one-off scheduled work. Read watchdog_list for the backend timezone. Derive a durable prompt from the current conversation. Scheduled checks must call watchdog_report.'}); return; }
    if(msg.method==='ping') {send({});return;}
    if(msg.method==='tools/list') {send({tools:watchdogTools});return;}
    if(msg.method==='tools/call') {try {send({content:[{type:'text',text:JSON.stringify(await call(msg.params || {}))}]});} catch(error) {send({isError:true,content:[{type:'text',text:error instanceof Error?error.message:String(error)}]});}return;}
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,error:{code:-32601,message:'Unsupported method'}})+'\n');
  })(); });
}

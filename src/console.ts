const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);

export const consoleHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ATS 本地任务控制台</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; background: #101827; color: #e5edf8; }
    body { max-width: 1120px; margin: 0 auto; padding: 28px 20px 48px; }
    h1 { margin: 0; } .subtle { color: #9fb0c6; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 10px; margin: 24px 0; }
    select, button { border-radius: 7px; border: 1px solid #3b4b65; background: #18243a; color: inherit; padding: 9px 11px; font: inherit; }
    select { min-width: 360px; flex: 1; } button { cursor: pointer; }
    #error { color: #ffb4ab; min-height: 1.3em; } #content { display: grid; gap: 16px; }
    section { border: 1px solid #2c3c56; border-radius: 10px; padding: 16px; background: #142038; }
    h2 { font-size: 1.05rem; margin: 0 0 12px; } dl { display: grid; grid-template-columns: max-content 1fr; gap: 7px 16px; margin: 0; } dt { color: #9fb0c6; } dd { margin: 0; overflow-wrap: anywhere; }
    table { border-collapse: collapse; width: 100%; font-size: .92rem; } th, td { border-bottom: 1px solid #2c3c56; text-align: left; padding: 8px; vertical-align: top; overflow-wrap: anywhere; } th { color: #9fb0c6; }
    code { white-space: pre-wrap; } .empty { color: #9fb0c6; }
    @media (max-width: 600px) { select { min-width: 0; width: 100%; } table { display: block; overflow-x: auto; } }
  </style>
</head>
<body>
  <h1>项目任务队列与任务证据包</h1>
  <p class="subtle">本地只读视图：项目级就绪度、风险、依赖关系、负责人交接、计划决定、执行失败与重试、状态迁移、验收和审计记录。</p>
  <div class="toolbar"><select id="task-select" aria-label="任务"><option value="">选择任务</option></select><button id="reload" type="button">刷新</button></div>
  <p id="error" role="alert"></p><main id="content" aria-live="polite"><p class="empty">正在加载任务…</p></main>
  <script type="module" src="/console.js"></script>
</body>
</html>`;

export const consoleScript = `
const select = document.querySelector('#task-select');
const content = document.querySelector('#content');
const error = document.querySelector('#error');
const escapeHtml = ${escapeHtml.toString()};
const text = value => escapeHtml(value ?? '—');
const rows = (items, columns) => items.length ? '<table><thead><tr>' + columns.map(column => '<th>' + text(column.label) + '</th>').join('') + '</tr></thead><tbody>' + items.map(item => '<tr>' + columns.map(column => '<td>' + (column.html ? column.html(item) : text(item[column.key])) + '</td>').join('') + '</tr>').join('') + '</tbody></table>' : '<p class="empty">无记录</p>';
const details = values => '<dl>' + values.map(([label, value]) => '<dt>' + text(label) + '</dt><dd>' + text(value) + '</dd>').join('') + '</dl>';
const section = (title, html) => '<section><h2>' + text(title) + '</h2>' + html + '</section>';
function render(evidence) {
  const plan = evidence.plan ? details([['状态', evidence.plan.status], ['决策人', evidence.plan.decided_by], ['决定时间', evidence.plan.decided_at], ['内容', evidence.plan.body]]) : '<p class="empty">没有关联计划</p>';
  const acceptance = evidence.acceptance ? details([['验收人', evidence.acceptance.actor], ['验收时间', evidence.acceptance.created_at], ['审计事件', evidence.acceptance.event_id]]) : '<p class="empty">尚未验收</p>';
  content.innerHTML = section('任务', details([['标题', evidence.task.title], ['状态', evidence.task.status], ['当前负责人', evidence.task.owner], ['任务 ID', evidence.task.id], ['创建时间', evidence.task.created_at]]))
    + section('负责人责任链', rows(evidence.responsibility_chain, [{ label: '原负责人', key: 'from_owner' }, { label: '新负责人', key: 'to_owner' }, { label: '交接原因', key: 'reason' }, { label: '操作人', key: 'actor' }, { label: '时间', key: 'created_at' }, { label: '审计事件', key: 'event_id' }]))
    + section('前置依赖', rows(evidence.dependencies, [{ label: '关联任务', html: dependency => text(dependency.depends_on_title) + ' / ' + text(dependency.depends_on_task_id) }, { label: '任务状态', key: 'depends_on_status' }, { label: '阻塞是否解除', html: dependency => dependency.satisfied ? '是' : '否' }, { label: '建立时间', key: 'created_at' }, { label: '解除时间', key: 'resolved_at' }]))
    + section('阻塞的后续任务', rows(evidence.blocked_dependents, [{ label: '关联任务', html: dependency => text(dependency.task_title) + ' / ' + text(dependency.task_id) }, { label: '任务状态', key: 'task_status' }, { label: '依赖已解除', html: dependency => dependency.satisfied ? '是' : '否' }, { label: '建立时间', key: 'created_at' }, { label: '解除时间', key: 'resolved_at' }]))
    + section('计划决定', plan)
    + section('执行', rows(evidence.executions, [{ label: '执行 ID', key: 'id' }, { label: '重试来源', key: 'retry_of_execution_id' }, { label: 'Provider', key: 'provider' }, { label: '状态', key: 'status' }, { label: '失败类别', key: 'failure_category' }, { label: '失败原因', key: 'failure_reason' }, { label: '启动责任人', key: 'started_by' }, { label: '完成责任人', key: 'finished_by' }, { label: '创建时间', key: 'created_at' }, { label: '完成时间', key: 'finished_at' }]))
    + section('状态迁移', rows(evidence.status_transitions, [{ label: '从', key: 'from' }, { label: '到', key: 'to' }, { label: '责任人', key: 'actor' }, { label: '时间', key: 'created_at' }]))
    + section('验收', acceptance)
    + section('项目决策记忆（只读）', rows(evidence.decision_memories, [{ label: '内容', key: 'content' }, { label: '来源', html: decision => text(decision.source_type) + ': ' + text(decision.source_reference) }, { label: '适用范围', key: 'scope' }, { label: '状态', key: 'status' }, { label: '替代决策', html: decision => text(decision.superseded_by_content) + ' / ' + text(decision.superseded_by) }, { label: '创建者', key: 'created_by' }, { label: '创建时间', key: 'created_at' }]))
    + section('审计记录', rows(evidence.audit_events, [{ label: '序号', key: 'sequence' }, { label: '实体', html: event => text(event.entity_type) + ' / ' + text(event.entity_id) }, { label: '动作', key: 'action' }, { label: '责任人', key: 'actor' }, { label: '详情', html: event => '<code>' + text(JSON.stringify(event.detail)) + '</code>' }, { label: '时间', key: 'created_at' }]));
}
function renderDependencyStatus(view) {
  const summary = view.can_start ? '<p>依赖与现有执行门禁均已满足：任务可按既有执行入口启动。</p>' : '<p class="empty">任务尚不能启动；请完成下列未满足条件。</p>';
  return section('依赖状态与下一步条件', summary + details([['当前可执行', view.can_start ? '是' : '否']])
    + '<h3>阻塞原因</h3>' + rows(view.blocking_reasons, [{ label: '代码', key: 'code' }, { label: '关联任务', key: 'task_id' }, { label: '任务状态', key: 'status' }, { label: '执行记录', key: 'execution_id' }])
    + '<h3>执行条件</h3>' + rows(view.next_executable_conditions, [{ label: '条件', key: 'code' }, { label: '已满足', html: condition => condition.satisfied ? '是' : '否' }, { label: '关联任务', key: 'task_id' }]));
}
function renderRisk(result) {
  const risk = result.risk;
  return section('时效风险与升级信号', risk
    ? details([['风险代码', risk.risk_code], ['严重度', risk.severity], ['负责人', risk.owner], ['最后活动', risk.last_activity_at], ['触发事实', JSON.stringify(risk.trigger_facts)], ['下一步', risk.next_action.code], ['处置条件', risk.next_action.condition]])
    : '<p class="empty">当前未检测到时效风险。</p>');
}
function renderQueue(items) {
  return section('项目执行队列（只读）', rows(items, [{ label: '队列状态', key: 'queue_status' }, { label: '任务', html: item => text(item.title) + ' / ' + text(item.task_id) }, { label: '负责人', key: 'owner' }, { label: '任务状态', key: 'task_status' }, { label: '原因代码', key: 'reason_code' }, { label: '触发事实', html: item => '<code>' + text(JSON.stringify(item.trigger_facts)) + '</code>' }, { label: '下一步', html: item => text(item.next_action.code) + '：' + text(item.next_action.condition) }]));
}
async function loadEvidence() {
  error.textContent = '';
  if (!select.value) { content.innerHTML = '<p class="empty">选择一个任务以查看证据包。</p>'; return; }
  try {
    const taskId = encodeURIComponent(select.value);
    const [evidenceResponse, dependencyResponse, riskResponse] = await Promise.all([fetch('/tasks/' + taskId + '/evidence'), fetch('/tasks/' + taskId + '/dependency-status'), fetch('/tasks/' + taskId + '/risk')]);
    if (!evidenceResponse.ok || !dependencyResponse.ok || !riskResponse.ok) throw new Error('请求失败（HTTP ' + (!evidenceResponse.ok ? evidenceResponse.status : !dependencyResponse.ok ? dependencyResponse.status : riskResponse.status) + '）');
    const evidence = await evidenceResponse.json();
    const queueResponse = await fetch('/projects/' + encodeURIComponent(evidence.task.project_id) + '/queue');
    if (!queueResponse.ok) throw new Error('无法读取项目执行队列（HTTP ' + queueResponse.status + '）');
    render(evidence); content.insertAdjacentHTML('afterbegin', renderRisk(await riskResponse.json())); content.insertAdjacentHTML('afterbegin', renderDependencyStatus(await dependencyResponse.json())); content.insertAdjacentHTML('afterbegin', renderQueue(await queueResponse.json()));
  } catch (reason) { error.textContent = reason instanceof Error ? reason.message : '无法加载证据包'; }
}
async function loadTasks() {
  try {
    const response = await fetch('/tasks'); if (!response.ok) throw new Error('无法读取任务');
    const tasks = await response.json(); const selected = new URLSearchParams(location.search).get('taskId');
    select.innerHTML = '<option value="">选择任务</option>' + tasks.map(task => '<option value="' + text(task.id) + '">' + text(task.title) + ' / ' + text(task.status) + ' (' + text(task.id) + ')</option>').join('');
    if (selected && tasks.some(task => task.id === selected)) { select.value = selected; await loadEvidence(); } else if (!tasks.length) { content.innerHTML = '<p class="empty">当前没有任务。</p>'; }
  } catch (reason) { error.textContent = reason instanceof Error ? reason.message : '无法加载任务'; content.innerHTML = ''; }
}
select.addEventListener('change', loadEvidence); document.querySelector('#reload').addEventListener('click', () => loadEvidence()); loadTasks();
`;

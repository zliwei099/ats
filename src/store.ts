import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type PlanStatus = 'draft' | 'submitted' | 'approved' | 'rejected';
export type TaskStatus = 'planned' | 'ready' | 'executing' | 'awaiting_acceptance' | 'accepted' | 'rejected';
export type FailureCategory = 'provider_error' | 'timeout' | 'validation_error' | 'cancelled' | 'unknown';
type RecordRow = Record<string, unknown>;

type AuditEventRow = RecordRow & {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  actor: string;
  detail: string;
  created_at: string;
  sequence: number | null;
};

export type EvidencePackage = {
  task: RecordRow;
  dependencies: Array<RecordRow>;
  blocked_dependents: Array<RecordRow>;
  plan: RecordRow | null;
  executions: Array<RecordRow & { started_by: string | null; finished_by: string | null }>;
  status_transitions: Array<{ event_id: string; from: string; to: string; actor: string; created_at: string }>;
  acceptance: { event_id: string; actor: string; created_at: string } | null;
  audit_events: Array<RecordRow & { detail: unknown }>;
  decision_memories: Array<RecordRow>;
};

export type DecisionSource = { type: 'url' | 'task' | 'audit'; reference: string };

export class DomainError extends Error {
  constructor(message: string, readonly code = 'DOMAIN_ERROR') { super(message); }
}

const transitions: Record<TaskStatus, TaskStatus[]> = {
  planned: ['ready'], ready: ['executing'], executing: ['awaiting_acceptance', 'ready'],
  awaiting_acceptance: ['accepted', 'rejected'], accepted: [], rejected: ['ready']
};

export class Store {
  readonly db: Database.Database;
  constructor(filename = ':memory:') {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id), body TEXT NOT NULL, status TEXT NOT NULL, decided_by TEXT, created_at TEXT NOT NULL, decided_at TEXT);
      CREATE TABLE IF NOT EXISTS executions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), provider TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT, failure_category TEXT, failure_reason TEXT, retry_of_execution_id TEXT REFERENCES executions(id));
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_execution_per_task ON executions(task_id) WHERE status = 'active';
      CREATE TABLE IF NOT EXISTS task_dependencies (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), depends_on_task_id TEXT NOT NULL REFERENCES tasks(id), created_at TEXT NOT NULL, resolved_at TEXT, UNIQUE(task_id, depends_on_task_id), CHECK(task_id <> depends_on_task_id));
      CREATE INDEX IF NOT EXISTS task_dependencies_depends_on ON task_dependencies(depends_on_task_id);
      CREATE TABLE IF NOT EXISTS decision_memories (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        content TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK(source_type IN ('url', 'task', 'audit')),
        source_reference TEXT NOT NULL,
        scope TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_sequence INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'superseded')),
        superseded_by TEXT REFERENCES decision_memories(id)
      );
      CREATE INDEX IF NOT EXISTS decision_memories_project_status_created ON decision_memories(project_id, status, created_at, id);
      CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL, sequence INTEGER);
    `);
    const columns = this.db.prepare('PRAGMA table_info(audit_events)').all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'sequence')) this.db.exec('ALTER TABLE audit_events ADD COLUMN sequence INTEGER');
    const executionColumns = this.db.prepare('PRAGMA table_info(executions)').all() as Array<{ name: string }>;
    if (!executionColumns.some(column => column.name === 'failure_category')) this.db.exec('ALTER TABLE executions ADD COLUMN failure_category TEXT');
    if (!executionColumns.some(column => column.name === 'failure_reason')) this.db.exec('ALTER TABLE executions ADD COLUMN failure_reason TEXT');
    if (!executionColumns.some(column => column.name === 'retry_of_execution_id')) this.db.exec('ALTER TABLE executions ADD COLUMN retry_of_execution_id TEXT');
    const decisionMemoryColumns = this.db.prepare('PRAGMA table_info(decision_memories)').all() as Array<{ name: string }>;
    if (!decisionMemoryColumns.some(column => column.name === 'created_sequence')) {
      this.db.exec('ALTER TABLE decision_memories ADD COLUMN created_sequence INTEGER');
      this.db.exec('UPDATE decision_memories SET created_sequence = rowid WHERE created_sequence IS NULL');
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS decision_memories_project_status_order ON decision_memories(project_id, status, created_at, created_sequence)');
  }
  private now() { return new Date().toISOString(); }
  private audit(entityType: string, entityId: string, action: string, actor: string, detail: unknown) {
    this.db.prepare('INSERT INTO audit_events (id, entity_type, entity_id, action, actor, detail, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM audit_events))')
      .run(randomUUID(), entityType, entityId, action, actor, JSON.stringify(detail), this.now());
  }
  createProject(name: string, actor = 'system') {
    const id = randomUUID(); const createdAt = this.now();
    this.db.prepare('INSERT INTO projects VALUES (?, ?, ?)').run(id, name, createdAt);
    this.audit('project', id, 'created', actor, { name }); return { id, name, createdAt };
  }
  createTask(projectId: string, title: string, actor = 'system') {
    if (!this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new DomainError('project not found', 'NOT_FOUND');
    const id = randomUUID(); const createdAt = this.now();
    this.db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?)').run(id, projectId, title, 'planned', createdAt);
    this.audit('task', id, 'created', actor, { projectId, title }); return this.task(id);
  }
  private project(id: string) {
    const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as RecordRow | undefined;
    if (!project) throw new DomainError('project not found', 'NOT_FOUND');
    return project;
  }
  private validateDecisionSource(source: DecisionSource) {
    if (!source || !['url', 'task', 'audit'].includes(source.type) || typeof source.reference !== 'string' || !source.reference.trim()) {
      throw new DomainError('decision source must be a URL, task, or audit reference', 'INVALID_DECISION_SOURCE');
    }
    if (source.type === 'url') {
      try { new URL(source.reference); } catch { throw new DomainError('decision URL source is invalid', 'INVALID_DECISION_SOURCE'); }
    }
  }
  createDecisionMemory(projectId: string, content: string, source: DecisionSource, scope: string, actor = 'system') {
    this.project(projectId); this.validateDecisionSource(source);
    if (!content?.trim() || !scope?.trim()) throw new DomainError('decision content and scope are required', 'INVALID_DECISION');
    const id = randomUUID(); const createdAt = this.now();
    this.db.prepare(`INSERT INTO decision_memories (id, project_id, content, source_type, source_reference, scope, created_by, created_at, created_sequence, status, superseded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(created_sequence), 0) + 1 FROM decision_memories), 'active', NULL)`).run(id, projectId, content.trim(), source.type, source.reference.trim(), scope.trim(), actor, createdAt);
    this.audit('decision_memory', id, 'created', actor, { projectId, source, scope: scope.trim() });
    return this.decisionMemory(id);
  }
  decisionMemory(id: string) {
    const row = this.db.prepare(`SELECT decision.*, replacement.content AS superseded_by_content
      FROM decision_memories decision LEFT JOIN decision_memories replacement ON replacement.id = decision.superseded_by WHERE decision.id = ?`).get(id) as RecordRow | undefined;
    if (!row) throw new DomainError('decision memory not found', 'NOT_FOUND');
    return row;
  }
  decisionMemories(projectId: string, status: 'active' | 'superseded' | 'all' = 'active') {
    this.project(projectId);
    const filter = status === 'all' ? '' : ' AND decision.status = ?';
    const params = status === 'all' ? [projectId] : [projectId, status];
    return this.db.prepare(`SELECT decision.*, replacement.content AS superseded_by_content
      FROM decision_memories decision LEFT JOIN decision_memories replacement ON replacement.id = decision.superseded_by
      WHERE decision.project_id = ?${filter} ORDER BY decision.created_at, decision.created_sequence`).all(...params) as RecordRow[];
  }
  supersedeDecisionMemory(id: string, replacementId: string, actor = 'system') {
    const decision = this.decisionMemory(id); const replacement = this.decisionMemory(replacementId);
    if (id === replacementId || decision.project_id !== replacement.project_id) throw new DomainError('replacement decision must be another decision in the same project', 'INVALID_SUPERSESSION');
    if (decision.status !== 'active') throw new DomainError('only active decisions may be superseded', 'INVALID_STATE');
    this.db.prepare("UPDATE decision_memories SET status='superseded', superseded_by=? WHERE id=?").run(replacementId, id);
    this.audit('decision_memory', id, 'superseded', actor, { replacementId });
    this.audit('decision_memory', replacementId, 'supersedes', actor, { decisionId: id });
    return this.decisionMemory(id);
  }
  addDependency(taskId: string, dependsOnTaskId: string, actor = 'system') {
    const task = this.task(taskId); const prerequisite = this.task(dependsOnTaskId);
    if (taskId === dependsOnTaskId) throw new DomainError('a task cannot depend on itself', 'INVALID_DEPENDENCY');
    if (task.project_id !== prerequisite.project_id) throw new DomainError('dependencies must be in the same project', 'INVALID_DEPENDENCY');
    const cycle = this.db.prepare(`WITH RECURSIVE reachable(id) AS (
      SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?
      UNION
      SELECT dependency.depends_on_task_id FROM task_dependencies dependency JOIN reachable ON dependency.task_id = reachable.id
    ) SELECT 1 FROM reachable WHERE id = ? LIMIT 1`).get(dependsOnTaskId, taskId);
    if (cycle) throw new DomainError('dependency would create a cycle', 'INVALID_DEPENDENCY');
    const id = randomUUID(); const createdAt = this.now();
    try { this.db.prepare('INSERT INTO task_dependencies (id, task_id, depends_on_task_id, created_at, resolved_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, taskId, dependsOnTaskId, createdAt, prerequisite.status === 'accepted' ? createdAt : null); }
    catch { throw new DomainError('dependency already exists', 'CONFLICT'); }
    this.audit('task', taskId, 'dependency_created', actor, { dependencyId: id, dependsOnTaskId, role: 'dependent' });
    this.audit('task', dependsOnTaskId, 'dependency_created', actor, { dependencyId: id, taskId, role: 'prerequisite' });
    if (prerequisite.status === 'accepted') {
      this.audit('task', taskId, 'dependency_resolved', actor, { dependencyId: id, dependsOnTaskId, role: 'dependent' });
      this.audit('task', dependsOnTaskId, 'dependency_resolved', actor, { dependencyId: id, taskId, role: 'prerequisite' });
    }
    return this.dependencies(taskId).find(dependency => dependency.id === id)!;
  }
  dependencies(taskId: string) {
    this.task(taskId);
    return this.db.prepare(`SELECT dependency.id, dependency.task_id, dependency.depends_on_task_id, dependency.created_at, dependency.resolved_at,
      prerequisite.title AS depends_on_title, prerequisite.status AS depends_on_status,
      CASE WHEN dependency.resolved_at IS NOT NULL THEN 1 ELSE 0 END AS satisfied
      FROM task_dependencies dependency JOIN tasks prerequisite ON prerequisite.id = dependency.depends_on_task_id
      WHERE dependency.task_id = ? ORDER BY dependency.created_at, dependency.id`).all(taskId) as RecordRow[];
  }
  blockedDependents(taskId: string) {
    this.task(taskId);
    return this.db.prepare(`SELECT dependency.id, dependency.task_id, dependency.depends_on_task_id, dependency.created_at, dependency.resolved_at,
      dependent.title AS task_title, dependent.status AS task_status,
      CASE WHEN dependency.resolved_at IS NOT NULL THEN 1 ELSE 0 END AS satisfied
      FROM task_dependencies dependency JOIN tasks dependent ON dependent.id = dependency.task_id
      WHERE dependency.depends_on_task_id = ? ORDER BY dependency.created_at, dependency.id`).all(taskId) as RecordRow[];
  }
  task(id: string) { const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as RecordRow | undefined; if (!row) throw new DomainError('task not found', 'NOT_FOUND'); return row; }
  tasks(status?: TaskStatus) {
    return this.db.prepare(status ? 'SELECT * FROM tasks WHERE status=? ORDER BY created_at, id' : 'SELECT * FROM tasks ORDER BY created_at, id').all(...(status ? [status] : [])) as RecordRow[];
  }
  createPlan(taskId: string, body: string, actor = 'system') {
    this.task(taskId); const id = randomUUID(); const createdAt = this.now();
    try { this.db.prepare('INSERT INTO plans (id, task_id, body, status, created_at) VALUES (?, ?, ?, ?, ?)').run(id, taskId, body, 'draft', createdAt); }
    catch { throw new DomainError('task already has a plan', 'CONFLICT'); }
    this.audit('plan', id, 'created', actor, { taskId }); return this.plan(id);
  }
  plan(id: string) { const row = this.db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as RecordRow | undefined; if (!row) throw new DomainError('plan not found', 'NOT_FOUND'); return row; }
  submitPlan(id: string, actor = 'system') { return this.changePlan(id, 'submitted', actor); }
  decidePlan(id: string, approved: boolean, actor: string) {
    const plan = this.plan(id); if (plan.status !== 'submitted') throw new DomainError('only submitted plans may be decided', 'INVALID_STATE');
    const status: PlanStatus = approved ? 'approved' : 'rejected';
    this.db.prepare('UPDATE plans SET status=?, decided_by=?, decided_at=? WHERE id=?').run(status, actor, this.now(), id);
    if (approved) this.transitionTask(String(plan.task_id), 'ready', actor);
    this.audit('plan', id, approved ? 'approved' : 'rejected', actor, {}); return this.plan(id);
  }
  private changePlan(id: string, target: PlanStatus, actor: string) {
    const plan = this.plan(id); if (plan.status !== 'draft' || target !== 'submitted') throw new DomainError('invalid plan transition', 'INVALID_STATE');
    this.db.prepare('UPDATE plans SET status=? WHERE id=?').run(target, id); this.audit('plan', id, 'submitted', actor, {}); return this.plan(id);
  }
  transitionTask(id: string, target: TaskStatus, actor = 'system') {
    const task = this.task(id); const current = task.status as TaskStatus;
    if (!transitions[current].includes(target)) throw new DomainError(`cannot transition task from ${current} to ${target}`, 'INVALID_STATE');
    this.db.prepare('UPDATE tasks SET status=? WHERE id=?').run(target, id); this.audit('task', id, 'status_changed', actor, { from: current, to: target });
    if (target === 'accepted') {
      const unresolved = this.db.prepare('SELECT id, task_id FROM task_dependencies WHERE depends_on_task_id=? AND resolved_at IS NULL ORDER BY created_at, id').all(id) as Array<{ id: string; task_id: string }>;
      const resolvedAt = this.now();
      this.db.prepare('UPDATE task_dependencies SET resolved_at=? WHERE depends_on_task_id=? AND resolved_at IS NULL').run(resolvedAt, id);
      for (const dependency of unresolved) {
        this.audit('task', dependency.task_id, 'dependency_resolved', actor, { dependencyId: dependency.id, dependsOnTaskId: id, role: 'dependent' });
        this.audit('task', id, 'dependency_resolved', actor, { dependencyId: dependency.id, taskId: dependency.task_id, role: 'prerequisite' });
      }
    }
    return this.task(id);
  }
  startExecution(taskId: string, provider: string, actor = 'system', retryOfExecutionId?: string) {
    const task = this.task(taskId);
    const plan = this.db.prepare("SELECT * FROM plans WHERE task_id=? AND status='approved'").get(taskId);
    if (!plan) throw new DomainError('execution requires an approved plan', 'PLAN_NOT_APPROVED');
    const unmet = this.dependencies(taskId).filter(dependency => !dependency.satisfied);
    if (unmet.length) throw new DomainError(`execution is blocked by ${unmet.map(dependency => String(dependency.depends_on_task_id)).join(', ')}`, 'DEPENDENCIES_UNMET');
    if (task.status !== 'ready') throw new DomainError('task must be ready before execution', 'INVALID_STATE');
    const id = randomUUID();
    try { this.db.prepare('INSERT INTO executions (id, task_id, provider, status, created_at, retry_of_execution_id) VALUES (?, ?, ?, ?, ?, ?)').run(id, taskId, provider, 'active', this.now(), retryOfExecutionId ?? null); }
    catch { throw new DomainError('task already has an active execution', 'EXECUTION_ACTIVE'); }
    this.transitionTask(taskId, 'executing', actor); this.audit('execution', id, 'started', actor, { taskId, provider, retryOfExecutionId: retryOfExecutionId ?? null }); return this.execution(id);
  }
  finishExecution(id: string, actor = 'system') {
    const execution = this.execution(id); if (execution.status !== 'active') throw new DomainError('execution is not active', 'INVALID_STATE');
    this.db.prepare("UPDATE executions SET status='completed', finished_at=? WHERE id=?").run(this.now(), id);
    this.transitionTask(String(execution.task_id), 'awaiting_acceptance', actor); this.audit('execution', id, 'finished', actor, {}); return this.execution(id);
  }
  failExecution(id: string, category: FailureCategory, reason: string, actor = 'system') {
    if (!['provider_error', 'timeout', 'validation_error', 'cancelled', 'unknown'].includes(category)) throw new DomainError('failure category is invalid', 'INVALID_FAILURE');
    if (!reason?.trim()) throw new DomainError('failure reason is required', 'INVALID_FAILURE');
    const execution = this.execution(id); if (execution.status !== 'active') throw new DomainError('execution is not active', 'INVALID_STATE');
    this.db.prepare("UPDATE executions SET status='failed', finished_at=?, failure_category=?, failure_reason=? WHERE id=?").run(this.now(), category, reason.trim(), id);
    this.transitionTask(String(execution.task_id), 'ready', actor);
    this.audit('execution', id, 'failed', actor, { taskId: execution.task_id, category, reason: reason.trim() });
    return this.execution(id);
  }
  retryExecution(id: string, actor = 'system') {
    const original = this.execution(id);
    if (original.status !== 'failed') throw new DomainError('only failed executions may be retried', 'INVALID_STATE');
    const retry = this.startExecution(String(original.task_id), String(original.provider), actor, id);
    this.audit('execution', id, 'retry_created', actor, { taskId: original.task_id, retryExecutionId: retry.id });
    this.audit('execution', String(retry.id), 'retry_of', actor, { taskId: original.task_id, originalExecutionId: id });
    this.audit('task', String(original.task_id), 'execution_retried', actor, { originalExecutionId: id, retryExecutionId: retry.id });
    return retry;
  }
  execution(id: string) { const row = this.db.prepare('SELECT * FROM executions WHERE id=?').get(id) as RecordRow | undefined; if (!row) throw new DomainError('execution not found', 'NOT_FOUND'); return row; }
  auditEvents(entityId?: string) { return this.db.prepare(entityId ? 'SELECT * FROM audit_events WHERE entity_id=? ORDER BY sequence IS NULL, sequence, created_at, id' : 'SELECT * FROM audit_events ORDER BY sequence IS NULL, sequence, created_at, id').all(...(entityId ? [entityId] : [])); }
  evidencePackage(taskId: string): EvidencePackage {
    const task = this.task(taskId);
    const plan = this.db.prepare('SELECT * FROM plans WHERE task_id=?').get(taskId) as RecordRow | undefined;
    const executions = this.db.prepare('SELECT * FROM executions WHERE task_id=? ORDER BY created_at, id').all(taskId) as RecordRow[];
    const entityIds = [taskId, ...(plan ? [String(plan.id)] : []), ...executions.map(execution => String(execution.id))];
    const placeholders = entityIds.map(() => '?').join(', ');
    const events = this.db.prepare(`SELECT * FROM audit_events WHERE entity_id IN (${placeholders}) ORDER BY sequence IS NULL, sequence, created_at, id`).all(...entityIds) as AuditEventRow[];
    const decisionMemories = this.decisionMemories(String(task.project_id), 'all');
    const parsedEvents = events.map(event => ({ ...event, detail: JSON.parse(event.detail) as unknown }));
    const eventFor = (entityId: string, action: string) => events.find(event => event.entity_id === entityId && event.action === action);
    const statusTransitions = events
      .filter(event => event.entity_id === taskId && event.action === 'status_changed')
      .map(event => {
        const detail = JSON.parse(event.detail) as { from: string; to: string };
        return { event_id: event.id, from: detail.from, to: detail.to, actor: event.actor, created_at: event.created_at };
      });
    const acceptanceEvent = events.find(event => event.entity_id === taskId && event.action === 'status_changed' && (JSON.parse(event.detail) as { to?: string }).to === 'accepted');

    return {
      task,
      dependencies: this.dependencies(taskId),
      blocked_dependents: this.blockedDependents(taskId),
      plan: plan ?? null,
      executions: executions.map(execution => ({
        ...execution,
        started_by: eventFor(String(execution.id), 'started')?.actor ?? null,
        finished_by: eventFor(String(execution.id), 'finished')?.actor ?? null
      })),
      status_transitions: statusTransitions,
      acceptance: acceptanceEvent ? { event_id: acceptanceEvent.id, actor: acceptanceEvent.actor, created_at: acceptanceEvent.created_at } : null,
      audit_events: parsedEvents,
      decision_memories: decisionMemories
    };
  }
  close() { this.db.close(); }
}

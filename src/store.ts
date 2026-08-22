import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export type PlanStatus = 'draft' | 'submitted' | 'approved' | 'rejected';
export type TaskStatus = 'planned' | 'ready' | 'executing' | 'awaiting_acceptance' | 'accepted' | 'rejected';
type RecordRow = Record<string, unknown>;

export class DomainError extends Error {
  constructor(message: string, readonly code = 'DOMAIN_ERROR') { super(message); }
}

const transitions: Record<TaskStatus, TaskStatus[]> = {
  planned: ['ready'], ready: ['executing'], executing: ['awaiting_acceptance'],
  awaiting_acceptance: ['accepted', 'rejected'], accepted: [], rejected: ['ready']
};

export class Store {
  readonly db: Database.Database;
  constructor(filename = ':memory:') {
    this.db = new Database(filename);
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id), body TEXT NOT NULL, status TEXT NOT NULL, decided_by TEXT, created_at TEXT NOT NULL, decided_at TEXT);
      CREATE TABLE IF NOT EXISTS executions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), provider TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_execution_per_task ON executions(task_id) WHERE status = 'active';
      CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
    `);
  }
  private now() { return new Date().toISOString(); }
  private audit(entityType: string, entityId: string, action: string, actor: string, detail: unknown) {
    this.db.prepare('INSERT INTO audit_events VALUES (?, ?, ?, ?, ?, ?, ?)')
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
  task(id: string) { const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as RecordRow | undefined; if (!row) throw new DomainError('task not found', 'NOT_FOUND'); return row; }
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
    this.db.prepare('UPDATE tasks SET status=? WHERE id=?').run(target, id); this.audit('task', id, 'status_changed', actor, { from: current, to: target }); return this.task(id);
  }
  startExecution(taskId: string, provider: string, actor = 'system') {
    const task = this.task(taskId);
    const plan = this.db.prepare("SELECT * FROM plans WHERE task_id=? AND status='approved'").get(taskId);
    if (!plan) throw new DomainError('execution requires an approved plan', 'PLAN_NOT_APPROVED');
    if (task.status !== 'ready') throw new DomainError('task must be ready before execution', 'INVALID_STATE');
    const id = randomUUID();
    try { this.db.prepare('INSERT INTO executions (id, task_id, provider, status, created_at) VALUES (?, ?, ?, ?, ?)').run(id, taskId, provider, 'active', this.now()); }
    catch { throw new DomainError('task already has an active execution', 'EXECUTION_ACTIVE'); }
    this.transitionTask(taskId, 'executing', actor); this.audit('execution', id, 'started', actor, { taskId, provider }); return this.execution(id);
  }
  finishExecution(id: string, actor = 'system') {
    const execution = this.execution(id); if (execution.status !== 'active') throw new DomainError('execution is not active', 'INVALID_STATE');
    this.db.prepare("UPDATE executions SET status='completed', finished_at=? WHERE id=?").run(this.now(), id);
    this.transitionTask(String(execution.task_id), 'awaiting_acceptance', actor); this.audit('execution', id, 'finished', actor, {}); return this.execution(id);
  }
  execution(id: string) { const row = this.db.prepare('SELECT * FROM executions WHERE id=?').get(id) as RecordRow | undefined; if (!row) throw new DomainError('execution not found', 'NOT_FOUND'); return row; }
  auditEvents(entityId?: string) { return this.db.prepare(entityId ? 'SELECT * FROM audit_events WHERE entity_id=? ORDER BY created_at' : 'SELECT * FROM audit_events ORDER BY created_at').all(...(entityId ? [entityId] : [])); }
  close() { this.db.close(); }
}

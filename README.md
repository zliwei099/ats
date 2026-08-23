# ATS MVP

一个仅监听回环地址的 TypeScript / Fastify / SQLite 服务，提供项目与任务、计划审批、单执行者执行、审计事件和验收状态机。

## 运行

```sh
npm ci
npm run dev
```

服务仅绑定 `127.0.0.1:3000`，可用 `ATS_DB=./local.sqlite PORT=3100 npm run start` 覆盖本地数据库路径和端口。服务不读取或管理 Provider 凭据；`src/provider.ts` 定义最小 `ProviderAdapter` 契约。

## API 闭环

```sh
project=$(curl -sS -X POST http://127.0.0.1:3000/projects -H 'content-type: application/json' -d '{"name":"demo"}')
project_id=$(node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).id))' <<< "$project")
task=$(curl -sS -X POST http://127.0.0.1:3000/projects/$project_id/tasks -H 'content-type: application/json' -d '{"title":"ship"}')
task_id=$(node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).id))' <<< "$task")
plan=$(curl -sS -X POST http://127.0.0.1:3000/tasks/$task_id/plans -H 'content-type: application/json' -d '{"body":"approved work"}')
plan_id=$(node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).id))' <<< "$plan")
curl -sS -X POST http://127.0.0.1:3000/plans/$plan_id/submit -H 'content-type: application/json' -d '{}'
curl -sS -X POST http://127.0.0.1:3000/plans/$plan_id/approve -H 'content-type: application/json' -d '{"actor":"reviewer"}'
execution=$(curl -sS -X POST http://127.0.0.1:3000/tasks/$task_id/executions -H 'content-type: application/json' -d '{"provider":"noop"}')
execution_id=$(node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).id))' <<< "$execution")
curl -sS -X POST http://127.0.0.1:3000/executions/$execution_id/finish -H 'content-type: application/json' -d '{}'
curl -sS http://127.0.0.1:3000/audit/$task_id
curl -sS -X POST http://127.0.0.1:3000/tasks/$task_id/accept -H 'content-type: application/json' -d '{"actor":"reviewer"}'
curl -sS http://127.0.0.1:3000/tasks/$task_id/evidence
curl -sS http://127.0.0.1:3000/tasks/$task_id
```

最后一个响应的 `status` 应为 `accepted`。SQLite schema 会在服务首次启动时自动创建；如果 `ATS_DB` 指向不存在的父目录，服务也会自动创建该目录。

## 任务依赖与阻塞

创建前置任务和依赖任务后，以 `POST /tasks/:taskId/dependencies` 传入 `{ "dependsOnTaskId": "<前置任务ID>" }` 建立关系。仅同一项目内的任务可以关联；自依赖、重复关系和环状关系会被拒绝。依赖任务即使已有获批计划且处于 `ready`，只要前置任务未 `accepted`，`POST /tasks/:taskId/executions` 就返回 `422` 和 `DEPENDENCIES_UNMET`。前置任务经过既有审批、执行、验收闭环至 `accepted` 后，依赖自动解除，依赖任务仍需按原审批与状态机执行。

可用以下 loopback 步骤观察门禁（两个任务的计划都需按上一节的提交、批准步骤处理）：

```sh
prerequisite=$(curl -sS -X POST http://127.0.0.1:3000/projects/$project_id/tasks -H 'content-type: application/json' -d '{"title":"first"}')
prerequisite_id=$(node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).id))' <<< "$prerequisite")
dependent=$(curl -sS -X POST http://127.0.0.1:3000/projects/$project_id/tasks -H 'content-type: application/json' -d '{"title":"second"}')
dependent_id=$(node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).id))' <<< "$dependent")
curl -sS -X POST http://127.0.0.1:3000/tasks/$dependent_id/dependencies -H 'content-type: application/json' -d "{\"dependsOnTaskId\":\"$prerequisite_id\"}"
curl -sS -X POST http://127.0.0.1:3000/tasks/$dependent_id/executions -H 'content-type: application/json' -d '{"provider":"noop"}' # DEPENDENCIES_UNMET
curl -sS http://127.0.0.1:3000/tasks/$dependent_id/dependencies
curl -sS http://127.0.0.1:3000/tasks/$dependent_id/evidence
```

完成并验收 `$prerequisite_id` 后，最后两项读取会显示 `satisfied: 1` 与 `resolved_at`；此时才可对 `$dependent_id` 调用执行创建接口。

`GET /tasks/:taskId/dependencies` 以 `created_at, id` 稳定排序列出前置关系；`GET /tasks/:taskId/evidence` 同时包含 `dependencies`、`blocked_dependents` 和关联的创建/解除审计事件。控制台在任务证据包中只读展示前置依赖和被其阻塞的后续任务。

## 任务证据包查询

`GET /tasks/:taskId/evidence` 是给 loopback 控制台与独立复核使用的稳定证据视图。它只读取已有持久化记录，不会改写审计事件；响应包含 `task`、已关联的 `plan`、按 `created_at, id` 排序的 `executions`，以及按不可变写入 `sequence` 排序的 `audit_events`。`status_transitions` 和最终 `acceptance` 均由这些审计事件派生。计划的 `decided_by` 是审批人，执行条目的 `started_by` / `finished_by` 是执行者，`acceptance.actor` 是验收人（尚未验收时为 `null`）。

验证：`npm test`、`npm run typecheck`。

## 本地浏览器控制台

启动服务并按上面的 API 闭环创建一个已验收任务后，在浏览器打开 `http://127.0.0.1:3000/console`。下拉框只列出已验收任务；选择任务即可读取既有 `GET /tasks/:taskId/evidence` 证据包，按稳定顺序展示计划决策人、执行责任人、状态迁移、验收人和审计记录。也可以使用 `http://127.0.0.1:3000/console?taskId=<任务ID>` 直接打开某个已验收任务。

该控制台仅调用 `GET /tasks?status=accepted` 和 `GET /tasks/:taskId/evidence`，不提供任何写入操作，服务仍只监听 `127.0.0.1`。

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

## 失败处置与受控重试

活跃执行可显式写入稳定失败类别 `provider_error`、`timeout`、`validation_error`、`cancelled` 或 `unknown`，并提供简明原因。失败会结束该执行、将任务返回 `ready`，保留原执行与审计事件；不会覆盖历史记录。只有失败执行可重试：`POST /executions/:executionId/retry` 创建一个新的执行记录，并将其 `retry_of_execution_id` 关联到原执行。

重试不会自动运行，也不绕过任何既有门禁：它重新检查已批准计划、全部依赖已解除、任务处于 `ready` 和单任务无活跃执行。任一条件不满足会以既有错误码拒绝，例如 `PLAN_NOT_APPROVED`、`DEPENDENCIES_UNMET` 或 `INVALID_STATE`。可在已启动的 loopback 服务上运行：

```sh
failed=$(curl -sS -X POST http://127.0.0.1:3000/executions/$execution_id/fail -H 'content-type: application/json' -d '{"category":"timeout","reason":"provider did not respond","actor":"executor"}')
retry=$(curl -sS -X POST http://127.0.0.1:3000/executions/$execution_id/retry -H 'content-type: application/json' -d '{"actor":"operator"}')
retry_id=$(node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).id))' <<< "$retry")
curl -sS http://127.0.0.1:3000/tasks/$task_id/evidence
```

`GET /tasks/:taskId/evidence` 以稳定顺序保留失败类别、原因、`retry_of_execution_id` 和 `failed` / `retry_created` / `retry_of` / `execution_retried` 审计事件。控制台现在可以选择所有任务，以只读方式展示失败和重试链路；不提供任何写入按钮。

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

### 依赖阻塞说明

`GET /tasks/:taskId/dependency-status` 是面向控制台和自动化协作方的只读门禁解释。它返回按 `created_at, id` 稳定排序的 `direct_prerequisites` 与 `direct_dependents`，以及机器可读的 `blockers`、`can_start` 和 `next_executable_condition`。前置关系中的 `blocker` 会准确说明当前尚未解除的原因，例如 `PREREQUISITE_PLAN_NOT_APPROVED`（前置未获批）、`PREREQUISITE_INCOMPLETE` / `PREREQUISITE_AWAITING_ACCEPTANCE`（前置未完成或待验收）、`PREREQUISITE_RETRY_REQUIRED` / `PREREQUISITE_RETRY_IN_PROGRESS`（失败后的既有重试链尚未完成）。当前任务自身仍未满足原有门禁时，`blockers` 会给出 `PLAN_NOT_APPROVED`、`TASK_NOT_READY` 或 `EXECUTION_ACTIVE`。

不存在的任务返回 `404 NOT_FOUND`；此查询不写入数据库，也不提供执行、审批、重试或交接的绕过入口：

```sh
curl -sS http://127.0.0.1:3000/tasks/$dependent_id/dependency-status
```

待所有 `blockers` 消失且 `can_start: true` 后，仍须调用既有 `POST /tasks/:taskId/executions`；服务会重新执行原有审批、依赖、状态机和单活跃执行检查。

## 任务证据包查询

`GET /tasks/:taskId/evidence` 是给 loopback 控制台与独立复核使用的稳定证据视图。它只读取已有持久化记录，不会改写审计事件；响应包含 `task`、已关联的 `plan`、按 `created_at, id` 排序的 `executions`，以及按不可变写入 `sequence` 排序的 `audit_events`。`status_transitions`、`responsibility_chain` 和最终 `acceptance` 均由这些审计事件派生。计划的 `decided_by` 是审批人，执行条目的 `started_by` / `finished_by` 是执行者，`acceptance.actor` 是验收人（尚未验收时为 `null`）。

## 负责人交接与责任链

任务创建者是初始负责人（创建任务时用 `actor` 指定；省略时为 `system`）。仅可通过 `POST /tasks/:taskId/handoffs` 交接，传入来源负责人、目标负责人和原因；交接追加 `ownership_handed_off` 审计事件，绝不会改写既有执行、审批、验收或失败—重试记录。来源和目标不得为空或相同，来源必须等于当前负责人；任务不存在返回 `404 NOT_FOUND`。若有活跃执行，接口返回 `409 EXECUTION_ACTIVE`，不改变当前负责人或审计历史。

```sh
curl -sS -X POST http://127.0.0.1:3000/tasks/$task_id/handoffs \
  -H 'content-type: application/json' \
  -d '{"fromOwner":"planner","toOwner":"executor-b","reason":"review completed","actor":"coordinator"}'
curl -sS http://127.0.0.1:3000/tasks/$task_id/evidence
```

成功后 `task.owner` 为 `executor-b`，稳定排序的 `responsibility_chain` 会保留初始负责人与每次交接的来源、目标、原因、操作人和时间。后续 `POST /tasks/:taskId/executions` 的执行启动归属当前负责人；之前执行保留原本的 `started_by`。控制台只读显示当前负责人和完整责任链，不提供交接按钮。

验证：`npm test`、`npm run typecheck`。

## 本地浏览器控制台

启动服务并按上面的 API 闭环创建一个已验收任务后，在浏览器打开 `http://127.0.0.1:3000/console`。下拉框列出所有任务；选择任务即可读取既有 `GET /tasks/:taskId/evidence` 与 `GET /tasks/:taskId/dependency-status`，按稳定顺序展示直接前置/反向依赖、阻塞原因、下一步条件、当前负责人、责任链、计划决策人、执行责任人、状态迁移、验收人和审计记录。也可以使用 `http://127.0.0.1:3000/console?taskId=<任务ID>` 直接打开某个任务。

该控制台仅调用只读的 `GET /tasks`、`GET /tasks/:taskId/evidence` 和 `GET /tasks/:taskId/dependency-status`，不提供任何写入操作，服务仍只监听 `127.0.0.1`。

## 项目决策记忆与来源追溯

决策记忆是项目级、可审计的协作记录，不是个人长期记忆。每条记录须包含简明内容、适用范围，以及结构化来源：`url`（完整 URL）、`task`（任务引用）或 `audit`（审计引用）。不得写入 API token、密钥、个人隐私或执行者私有经历。

```sh
decision=$(curl -sS -X POST http://127.0.0.1:3000/projects/$project_id/decision-memories -H 'content-type: application/json' -d '{"content":"本地 MVP 使用 SQLite","source":{"type":"url","reference":"https://example.test/adr/sqlite"},"scope":"本地 MVP","actor":"architect"}')
decision_id=$(node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).id))' <<< "$decision")
replacement=$(curl -sS -X POST http://127.0.0.1:3000/projects/$project_id/decision-memories -H 'content-type: application/json' -d '{"content":"并发读场景使用 SQLite WAL","source":{"type":"task","reference":"ATS-28"},"scope":"持久化","actor":"architect"}')
replacement_id=$(node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).id))' <<< "$replacement")
curl -sS -X POST http://127.0.0.1:3000/decision-memories/$decision_id/supersede -H 'content-type: application/json' -d "{\"replacementDecisionId\":\"$replacement_id\",\"actor\":\"reviewer\"}"
curl -sS http://127.0.0.1:3000/projects/$project_id/decision-memories                 # 默认仅 active
curl -sS 'http://127.0.0.1:3000/projects/'$project_id'/decision-memories?status=all' # 完整历史
```

替代关系只能连接同一项目内的两条不同决策；无效项目、无效来源或跨项目替代均被拒绝。所有列表按 `created_at, id` 稳定排序。任务证据包会只读包含该任务所属项目的完整决策历史；启动服务后打开 `http://127.0.0.1:3000/console`，选择已验收任务即可查看，控制台不提供决策或状态机的写入口。

## ATS-30 整合复验

候选分支须同时包含依赖门禁和项目决策记忆。以下命令在一个全新的 loopback 实例中覆盖两项功能；其中 `blocked` 的 HTTP 状态应为 `422` 且错误码为 `DEPENDENCIES_UNMET`，而 `allowed` 应为 `201`。脚本也验证决策替代后默认列表仅返回活跃记录、`status=all` 保留完整历史。

```sh
ATS_DB=./ats-30-verify.sqlite PORT=3100 npm run start &
server_pid=$!
trap 'kill "$server_pid"; rm -f ./ats-30-verify.sqlite ./ats-30-blocked.json' EXIT
base=http://127.0.0.1:3100
until curl -fsS "$base/health" >/dev/null; do sleep 0.1; done

post() { curl -sS -X POST "$1" -H 'content-type: application/json' -d "$2"; }
id() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))'; }
project_id=$(post "$base/projects" '{"name":"ATS-30 verification"}' | id)
prerequisite_id=$(post "$base/projects/$project_id/tasks" '{"title":"prerequisite"}' | id)
dependent_id=$(post "$base/projects/$project_id/tasks" '{"title":"dependent"}' | id)
for task_id in "$prerequisite_id" "$dependent_id"; do
  plan_id=$(post "$base/tasks/$task_id/plans" '{"body":"approved"}' | id)
  post "$base/plans/$plan_id/submit" '{}' >/dev/null
  post "$base/plans/$plan_id/approve" '{"actor":"reviewer"}' >/dev/null
done
post "$base/tasks/$dependent_id/dependencies" "{\"dependsOnTaskId\":\"$prerequisite_id\"}" >/dev/null
blocked_status=$(curl -sS -o ./ats-30-blocked.json -w '%{http_code}' -X POST "$base/tasks/$dependent_id/executions" -H 'content-type: application/json' -d '{"provider":"noop"}')
test "$blocked_status" = 422
node -e 'const r=JSON.parse(require("node:fs").readFileSync(process.argv[1])); if(r.error!=="DEPENDENCIES_UNMET") process.exit(1)' ./ats-30-blocked.json
prereq_execution_id=$(post "$base/tasks/$prerequisite_id/executions" '{"provider":"noop"}' | id)
post "$base/executions/$prereq_execution_id/finish" '{}' >/dev/null
post "$base/tasks/$prerequisite_id/accept" '{"actor":"reviewer"}' >/dev/null
allowed=$(post "$base/tasks/$dependent_id/executions" '{"provider":"noop"}')
node -e 'if(!JSON.parse(process.argv[1]).id) process.exit(1)' "$allowed"

first_id=$(post "$base/projects/$project_id/decision-memories" '{"content":"SQLite baseline","scope":"storage","source":{"type":"url","reference":"https://example.test/adr/sqlite"},"actor":"architect"}' | id)
second_id=$(post "$base/projects/$project_id/decision-memories" "{\"content\":\"SQLite WAL\",\"scope\":\"storage\",\"source\":{\"type\":\"task\",\"reference\":\"$prerequisite_id\"},\"actor\":\"architect\"}" | id)
post "$base/decision-memories/$first_id/supersede" "{\"replacementDecisionId\":\"$second_id\",\"actor\":\"reviewer\"}" >/dev/null
curl -fsS "$base/projects/$project_id/decision-memories" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);if(r.length!==1||r[0].id!==process.argv[1])process.exit(1)})' "$second_id"
curl -fsS "$base/projects/$project_id/decision-memories?status=all" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{if(JSON.parse(s).length!==2)process.exit(1)})'
```

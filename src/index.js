const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

// WebSocket连接管理器 - 简化版本，避免跨请求I/O
class WebSocketManager {
  constructor() {
    this.clients = new Set(); // 前端客户端
    this.agents = new Set();  // Agent客户端
    this.agentData = new Map(); // 存储Agent数据的简单缓存
  }

  // 添加前端客户端
  addClient(ws, type = 'client') {
    if (type === 'client') {
      this.clients.add(ws);
      console.log(`Frontend client connected. Total clients: ${this.clients.size}`);
    } else if (type === 'agent') {
      this.agents.add(ws);
      console.log(`Agent connected. Total agents: ${this.agents.size}`);
    }
  }

  // 移除连接
  remove(ws) {
    if (this.clients.has(ws)) {
      this.clients.delete(ws);
      console.log(`Frontend client disconnected. Total clients: ${this.clients.size}`);
    } else if (this.agents.has(ws)) {
      this.agents.delete(ws);
      console.log(`Agent disconnected. Total agents: ${this.agents.size}`);
    }
  }

  // 存储Agent数据（在同一个请求中）
  storeAgentData(nodeId, data) {
    this.agentData.set(nodeId, {
      ...data,
      lastUpdate: Date.now()
    });
    console.log(`Stored agent data for ${nodeId} in memory`);
  }

  // 获取Agent数据
  getAgentData(nodeId) {
    return this.agentData.get(nodeId);
  }

  // 注意：由于Cloudflare Workers的I/O限制，我们不能直接跨请求转发消息
  // 这个管理器主要用于在同一请求内管理连接
}

// 全局WebSocket管理器实例
const wsManager = new WebSocketManager();

export default {
  async fetch(request, env, ctx) {
    try {
      return await routeRequest(request, env, ctx);
    } catch (error) {
      console.error("request failed", error);
      return json(
        {
          ok: false,
          error: error instanceof Error ? error.message : "internal error",
        },
        500
      );
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(processOfflineAlerts(env));
  },
  // WebSocket连接管理
  async websocket(request, env, ctx) {
    try {
      // 解析WebSocket URL来确定连接类型
      const url = new URL(request.url);
      const path = url.pathname;
      
      if (path === '/ws/client') {
        return await handleClientWebSocket(request, env);
      } else if (path === '/ws/agent') {
        return await handleAgentWebSocket(request, env);
      } else {
        return new Response('Not Found', { status: 404 });
      }
    } catch (error) {
      return new Response(`WebSocket Error: ${error.message}`, { status: 500 });
    }
  }
};

async function routeRequest(request, env, ctx) {
  const url = new URL(request.url);
  const path = trimTrailingSlash(url.pathname);

  if (path === "") {
    return new Response(renderDashboardHtml(env), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  if (path.startsWith("/servers/") && request.method === "GET") {
    const nodeId = path.split("/")[2];
    if (!nodeId) {
      return json({ ok: false, error: "node id required" }, 400);
    }
    return new Response(renderServerDetailHtml(env, nodeId), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  if (path === "/admin" && request.method === "GET") {
    // 检查是否有认证token
    const auth = await getRequestAuth(request, env);
    if (!auth.authenticated) {
      // 检查是否是HTML请求，如果是则返回认证页面
      const accept = request.headers.get('accept') || '';
      if (accept.includes('text/html')) {
        return new Response(renderAuthHtml(), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      // API请求返回401
      return new Response('Unauthorized', { status: 401 });
    }
    return new Response(renderAdminHtml(env), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  if (path === "/api/health" && request.method === "GET") {
    return json({ ok: true, now: nowUnix() });
  }

  if (path === "/api/dashboard" && request.method === "GET") {
    const auth = await getRequestAuth(request, env);
    const factory = async () => {
      const data = await buildDashboardPayload(env, auth);
      return {
        ok: true,
        generated_at: nowUnix(),
        timeout_sec: getHeartbeatTimeoutSec(env),
        ...data,
      };
    };
    if (auth.authenticated) {
      return json(await factory());
    }
    return cachedJson(env, ctx, `${url.origin}/cache/dashboard/public`, 60, factory);
  }

  if (path === "/api/events" && request.method === "GET") {
    return sseStream();
  }

  if (path === "/ws/agent" && (request.method === "GET" || request.method === "HEAD")) {
    return handleAgentWebSocket(request, env);
  }

  if (path === "/ws/client" && (request.method === "GET" || request.method === "HEAD")) {
    return handleClientWebSocket(request, env);
  }

  if (path === "/api/auth/me" && request.method === "GET") {
    return json({
      ok: true,
      auth: await getRequestAuth(request, env),
    });
  }

  if (path === "/api/auth/login" && request.method === "POST") {
    const payload = await parseJson(request);
    const result = await loginWithPassword(env, payload.username, payload.password);
    await writeAuditLog(
      env,
      { mode: "session", user_id: result.user.id, username: result.user.username },
      "auth.login",
      "user",
      result.user.id,
      ""
    );
    return json(
      {
        ok: true,
        user: result.user,
      },
      200,
      {
        "set-cookie": makeSessionCookie(result.sessionToken, result.maxAgeSec),
      }
    );
  }

  if (path === "/api/auth/logout" && request.method === "POST") {
    const auth = await getRequestAuth(request, env);
    if (auth.session_id) {
      await env.DB.prepare("DELETE FROM sessions WHERE id = ?1").bind(auth.session_id).run();
    }
    if (auth.authenticated) {
      await writeAuditLog(env, auth, "auth.logout", "user", auth.user_id || auth.username || "unknown", "");
    }
    return json({ ok: true }, 200, {
      "set-cookie": makeSessionCookie("", 0),
    });
  }

  if (path === "/api/notifications" && request.method === "GET") {
    const auth = await requirePermission(request, env, "alerts.read");
    return json({
      ok: true,
      channels: await listNotificationChannels(env, hasPermission(auth.permissions || [], "alerts.manage")),
      logs: await listNotificationLogs(env, 20),
      policy: await getAlertPolicy(env),
    });
  }

  if (path === "/api/audit-logs" && request.method === "GET") {
    await requirePermission(request, env, "audit.read");
    return json({
      ok: true,
      logs: await listAuditLogs(env, Math.min(Number(url.searchParams.get("limit") || "50"), 200)),
    });
  }

  if (path === "/api/servers" && request.method === "GET") {
    return json({ ok: true, servers: await listServers(env, false) });
  }

  if (path.startsWith("/api/servers/") && request.method === "POST" && path.endsWith("/token")) {
    const nodeId = path.split("/")[3];
    if (!nodeId) {
      return json({ ok: false, error: "node id required" }, 400);
    }
    await requirePermission(request, env, "servers.manage");
    const result = await rotateServerToken(env, nodeId);
    ctx.waitUntil(clearDashboardCache(env, url.origin));
    return json({ ok: true, ...result });
  }

  if (path.startsWith("/api/servers/") && request.method === "GET") {
    const parts = path.split("/");
    const nodeId = parts[3];
    if (!nodeId) {
      return json({ ok: false, error: "node id required" }, 400);
    }
    if (parts[4] === "history") {
      const hours = Math.min(Number(url.searchParams.get("hours") || "24"), 168);
      return json({
        ok: true,
        node_id: nodeId,
        history: await listServerHistory(env, nodeId, hours),
      });
    }
    if (parts[4] === "metrics") {
      const hours = Math.min(Number(url.searchParams.get("hours") || "24"), 168);
      return json({
        ok: true,
        node_id: nodeId,
        metrics: await listServerMetrics(env, nodeId, hours),
      });
    }
    const auth = await getRequestAuth(request, env);
    return json({
      ok: true,
      server: await getServerDetails(env, nodeId, hasPermission(auth.permissions || [], "servers.manage")),
    });
  }

  if (path === "/api/heartbeat" && request.method === "POST") {
    const payload = await parseJson(request);
    await verifyAgentRequest(request, env, payload.node_id);
    const result = await upsertHeartbeat(env, payload);
    ctx.waitUntil(clearDashboardCache(env, url.origin));
    return json({ ok: true, ...result });
  }

  if (path === "/api/ddns/update" && request.method === "POST") {
    const payload = await parseJson(request);
    await verifyAgentRequest(request, env, payload.node_id);
    const result = await updateDdnsRecord(env, payload);
    ctx.waitUntil(clearDashboardCache(env, url.origin));
    return json({ ok: true, ...result });
  }

  if (path.startsWith("/api/ddns/resolve/") && request.method === "GET") {
    const hostname = decodeURIComponent(path.split("/")[4] || "");
    if (!hostname) {
      return json({ ok: false, error: "hostname required" }, 400);
    }
    const record = await env.DB.prepare(
      "SELECT hostname, node_id, type, content, proxied, ttl, zone_id, zone_name, comment, updated_at FROM ddns_records WHERE hostname = ?1"
    )
      .bind(hostname)
      .first();
    if (!record) {
      return json({ ok: false, error: "record not found" }, 404);
    }
    return json({ ok: true, record });
  }

  if (path.startsWith("/api/monitors/") && request.method === "GET") {
    const monitorId = path.split("/")[3];
    if (!monitorId) {
      return json({ ok: false, error: "monitor id required" }, 400);
    }
    return json({
      ok: true,
      history: await listMonitorHistory(env, monitorId, Math.min(Number(url.searchParams.get("limit") || "50"), 200)),
    });
  }

  if (path.startsWith("/api/tasks/") && path.endsWith("/runs") && request.method === "GET") {
    await requirePermission(request, env, "tasks.read");
    const taskId = path.split("/")[3];
    if (!taskId) {
      return json({ ok: false, error: "task id required" }, 400);
    }
    const limit = Math.min(Number(url.searchParams.get("limit") || "30"), 100);
    const offset = Math.max(Number(url.searchParams.get("offset") || "0"), 0);
    const query = (url.searchParams.get("q") || "").trim();
    return json({
      ok: true,
      ...(await listTaskRuns(env, taskId, limit, offset, query)),
    });
  }

  if (path === "/api/agent/monitors" && request.method === "GET") {
    const nodeId = url.searchParams.get("node_id") || "";
    await verifyAgentRequest(request, env, nodeId);
    return json({ ok: true, monitors: await listMonitorsForNode(env, nodeId) });
  }

  if (path === "/api/monitor-results" && request.method === "POST") {
    const payload = await parseJson(request);
    await verifyAgentRequest(request, env, payload.node_id);
    const result = await insertMonitorResult(env, payload);
    ctx.waitUntil(clearDashboardCache(env, url.origin));
    return json({ ok: true, ...result });
  }

  if (path === "/api/agent/tasks/poll" && request.method === "POST") {
    const payload = await parseJson(request);
    await verifyAgentRequest(request, env, payload.node_id);
    return json({
      ok: true,
      tasks: await dispatchDueTasks(env, payload.node_id),
    });
  }

  if (path === "/api/agent/tasks/result" && request.method === "POST") {
    const payload = await parseJson(request);
    await verifyAgentRequest(request, env, payload.node_id);
    const result = await completeTaskRun(env, payload);
    ctx.waitUntil(clearDashboardCache(env, url.origin));
    return json({ ok: true, ...result });
  }

  if (path === "/api/admin/groups/upsert" && request.method === "POST") {
    await requirePermission(request, env, "groups.manage");
    const payload = await parseJson(request);
    const result = await upsertGroup(env, payload);
    ctx.waitUntil(clearDashboardCache(env, url.origin));
    return json({ ok: true, ...result });
  }

  if (path === "/api/admin/servers/config" && request.method === "POST") {
    await requirePermission(request, env, "servers.manage");
    const payload = await parseJson(request);
    const result = await upsertServerConfig(env, payload);
    ctx.waitUntil(clearDashboardCache(env, url.origin));
    return json({ ok: true, ...result });
  }

  if (path === "/api/admin/monitors/upsert" && request.method === "POST") {
    await requirePermission(request, env, "monitors.manage");
    const payload = await parseJson(request);
    const result = await upsertMonitor(env, payload);
    ctx.waitUntil(clearDashboardCache(env, url.origin));
    return json({ ok: true, ...result });
  }

  if (path === "/api/admin/tasks/upsert" && request.method === "POST") {
    await requirePermission(request, env, "tasks.manage");
    const payload = await parseJson(request);
    const result = await upsertTask(env, payload);
    ctx.waitUntil(clearDashboardCache(env, url.origin));
    return json({ ok: true, ...result });
  }

  if (path === "/api/admin/tasks/trigger" && request.method === "POST") {
    await requirePermission(request, env, "tasks.run");
    const payload = await parseJson(request);
    const result = await triggerTask(env, payload.task_id);
    ctx.waitUntil(clearDashboardCache(env, url.origin));
    return json({ ok: true, ...result });
  }

  if (path === "/api/admin/notifications/upsert" && request.method === "POST") {
    await requirePermission(request, env, "alerts.manage");
    const payload = await parseJson(request);
    const result = await upsertNotificationChannel(env, payload);
    return json({ ok: true, ...result });
  }

  if (path === "/api/admin/alerts/run" && request.method === "POST") {
    await requirePermission(request, env, "alerts.run");
    const result = await processOfflineAlerts(env);
    return json({ ok: true, ...result });
  }

  if (path === "/api/admin/settings/alerts" && request.method === "POST") {
    await requirePermission(request, env, "alerts.manage");
    const payload = await parseJson(request);
    const result = await upsertAlertPolicy(env, payload);
    return json({ ok: true, ...result });
  }

  if (path === "/api/admin/settings/websocket" && request.method === "GET") {
    await requirePermission(request, env, "system.manage");
    const settings = await getWebSocketSettings(env);
    return json({ ok: true, settings });
  }

  if (path === "/api/admin/settings/websocket" && request.method === "POST") {
    await requirePermission(request, env, "system.manage");
    const payload = await parseJson(request);
    const result = await upsertWebSocketSettings(env, payload);
    return json({ ok: true, ...result });
  }

  if (path === "/api/admin/users" && request.method === "GET") {
    await requirePermission(request, env, "access.manage");
    return json({ ok: true, users: await listUsers(env) });
  }

  if (path === "/api/admin/users/upsert" && request.method === "POST") {
    const auth = await requirePermission(request, env, "access.manage");
    const payload = await parseJson(request);
    const result = await upsertUser(env, payload);
    await writeAuditLog(env, auth, "user.upsert", "user", result.id, payload.username || result.id);
    return json({ ok: true, ...result });
  }

  if (path === "/api/admin/api-tokens" && request.method === "GET") {
    await requirePermission(request, env, "access.manage");
    return json({ ok: true, tokens: await listApiTokens(env) });
  }

  if (path === "/api/admin/api-tokens/upsert" && request.method === "POST") {
    const auth = await requirePermission(request, env, "access.manage");
    const payload = await parseJson(request);
    const result = await upsertApiToken(env, payload, auth);
    await writeAuditLog(env, auth, "api_token.upsert", "api_token", result.id, result.name);
    return json({ ok: true, ...result });
  }

  if (path === "/api/admin/disable" && request.method === "POST") {
    const payload = await parseJson(request);
    const auth = await requirePermission(request, env, permissionForEntityAdminAction(payload.entity_type));
    const result = await setEntityEnabled(env, payload.entity_type, payload.id, false);
    await writeAuditLog(env, auth, "entity.disable", payload.entity_type, payload.id, "");
    ctx.waitUntil(clearDashboardCache(env, url.origin));
    return json({ ok: true, ...result });
  }

  if (path === "/api/admin/enable" && request.method === "POST") {
    const payload = await parseJson(request);
    const auth = await requirePermission(request, env, permissionForEntityAdminAction(payload.entity_type));
    const result = await setEntityEnabled(env, payload.entity_type, payload.id, true);
    await writeAuditLog(env, auth, "entity.enable", payload.entity_type, payload.id, "");
    ctx.waitUntil(clearDashboardCache(env, url.origin));
    return json({ ok: true, ...result });
  }

  if (path === "/api/admin/delete" && request.method === "POST") {
    const payload = await parseJson(request);
    const auth = await requirePermission(request, env, permissionForEntityAdminAction(payload.entity_type));
    const result = await deleteEntity(env, payload.entity_type, payload.id);
    await writeAuditLog(env, auth, "entity.delete", payload.entity_type, payload.id, "");
    ctx.waitUntil(clearDashboardCache(env, url.origin));
    return json({ ok: true, ...result });
  }

  return json({ ok: false, error: "not found" }, 404);
}

async function buildDashboardPayload(env, auth) {
  const canManageServers = hasPermission(auth?.permissions || [], "servers.manage");
  const canManageTasks = hasPermission(auth?.permissions || [], "tasks.manage");
  const canReadAlerts = hasPermission(auth?.permissions || [], "alerts.read");
  const canManageAlerts = hasPermission(auth?.permissions || [], "alerts.manage");
  const canAccessTokens = hasPermission(auth?.permissions || [], "access.manage");
  const canReadAudit = hasPermission(auth?.permissions || [], "audit.read");
  const [groups, servers, monitors, tasks, ddns, channels, notificationLogs, alertPolicy, apiTokens, auditLogs] = await Promise.all([
    listGroups(env),
    listServers(env, canManageServers),
    listMonitorSummary(env),
    listTaskSummary(env, canManageTasks),
    listDdnsRecords(env),
    canReadAlerts ? listNotificationChannels(env, canManageAlerts) : Promise.resolve([]),
    canReadAlerts ? listNotificationLogs(env, 10) : Promise.resolve([]),
    canReadAlerts ? getAlertPolicy(env) : Promise.resolve({}),
    canAccessTokens ? listApiTokens(env) : Promise.resolve([]),
    canReadAudit ? listAuditLogs(env, 10) : Promise.resolve([]),
  ]);

  const grouped = groups.map((group) => ({
    ...group,
    servers: servers.filter((server) => (server.group_id || "") === group.id),
  }));
  const ungrouped = servers.filter((server) => !server.group_id);
  if (ungrouped.length) {
    grouped.push({
      id: "",
      name: "Ungrouped",
      description: "",
      sort_order: 9999,
      servers: ungrouped,
    });
  }

  return {
    summary: {
      total_servers: servers.length,
      online_servers: servers.filter((server) => server.online).length,
      total_monitors: monitors.length,
      healthy_monitors: monitors.filter((monitor) => monitor.latest_status === "up").length,
      queued_tasks: tasks.filter((task) => task.next_run_at > 0).length,
      ddns_records: ddns.length,
      channels: channels.filter((channel) => channel.enabled).length,
    },
    groups: grouped,
    group_options: groups,
    servers,
    monitors,
    tasks,
    ddns_records: ddns,
    notification_channels: channels,
    notification_logs: notificationLogs,
    alert_policy: alertPolicy,
    api_tokens: apiTokens,
    audit_logs: auditLogs,
  };
}

async function listGroups(env) {
  const rows = await env.DB.prepare(
    "SELECT id, name, description, sort_order, updated_at FROM node_groups ORDER BY sort_order ASC, name ASC"
  ).all();
  return rows.results || [];
}

async function listServers(env, includePrivate) {
  const rows = await env.DB.prepare(
    `SELECT
      n.id,
      n.name,
      n.group_id,
      g.name AS group_name,
      n.tags,
      n.os,
      n.arch,
      n.version,
      n.location,
      n.public_note,
      n.private_note,
      n.hidden,
      n.ddns_enabled,
      n.public_ipv4,
      n.public_ipv6,
      n.private_ipv4,
      n.private_ipv6,
      n.cpu_cores,
      n.cpu_model,
      n.cpu_usage,
      n.process_count,
      n.tcp_conn_count,
      n.udp_conn_count,
      n.mem_total,
      n.mem_used,
      n.swap_total,
      n.swap_used,
      n.disk_total,
      n.disk_used,
      n.net_in_speed,
      n.net_out_speed,
      n.net_in_transfer,
      n.net_out_transfer,
      n.load_1,
      n.load_5,
      n.load_15,
      n.boot_time,
      n.last_seen,
      n.updated_at
    FROM nodes n
    LEFT JOIN node_groups g ON g.id = n.group_id
    ORDER BY COALESCE(g.sort_order, 9999) ASC, n.name ASC`
  ).all();

  const timeout = getHeartbeatTimeoutSec(env);
  return (rows.results || [])
    .filter((row) => !Number(row.hidden || 0))
    .map((row) => ({
      ...row,
      private_note: includePrivate ? row.private_note : "",
      hidden: Boolean(row.hidden),
      ddns_enabled: Boolean(row.ddns_enabled),
      tags: splitTags(row.tags),
      online: Number(row.last_seen || 0) >= nowUnix() - timeout,
      mem_usage_pct: percentage(row.mem_used, row.mem_total),
      disk_usage_pct: percentage(row.disk_used, row.disk_total),
    }));
}

async function getServerDetails(env, nodeId, includePrivate) {
  const server = await env.DB.prepare(
    `SELECT
      id, name, group_id, tags, os, arch, version, location,
      public_note, private_note, hidden, ddns_enabled,
      public_ipv4, public_ipv6, private_ipv4, private_ipv6,
      cpu_cores, cpu_model, cpu_usage, process_count, tcp_conn_count, udp_conn_count,
      mem_total, mem_used, swap_total, swap_used, disk_total, disk_used,
      net_in_speed, net_out_speed, net_in_transfer, net_out_transfer,
      load_1, load_5, load_15, boot_time, last_seen, updated_at
    FROM nodes
    WHERE id = ?1`
  )
    .bind(nodeId)
    .first();
  if (!server) {
    throw new Error("server not found");
  }
  return {
    ...server,
    private_note: includePrivate ? server.private_note : "",
    hidden: Boolean(server.hidden),
    ddns_enabled: Boolean(server.ddns_enabled),
    tags: splitTags(server.tags),
    mem_usage_pct: percentage(server.mem_used, server.mem_total),
    swap_usage_pct: percentage(server.swap_used, server.swap_total),
    disk_usage_pct: percentage(server.disk_used, server.disk_total),
    ddns_records: await env.DB.prepare(
      "SELECT hostname, type, content, proxied, ttl, updated_at FROM ddns_records WHERE node_id = ?1 ORDER BY hostname ASC"
    )
      .bind(nodeId)
      .all()
      .then((rows) => rows.results || []),
  };
}

async function listServerHistory(env, nodeId, hours) {
  const cutoff = nowUnix() - hours * 3600;
  const rows = await env.DB.prepare(
    `SELECT status, latency_ms, message, payload_json, created_at
     FROM heartbeats
     WHERE node_id = ?1 AND created_at >= ?2
     ORDER BY created_at DESC
     LIMIT 1000`
  )
    .bind(nodeId, cutoff)
    .all();
  return rows.results || [];
}

async function listServerMetrics(env, nodeId, hours) {
  const cutoff = nowUnix() - hours * 3600;
  const rows = await env.DB.prepare(
    `SELECT cpu_usage, mem_usage_pct, swap_usage_pct, disk_usage_pct, load_1, load_5, load_15, process_count, tcp_conn_count, udp_conn_count, net_in_speed, net_out_speed, net_in_transfer, net_out_transfer, created_at
     FROM resource_samples
     WHERE node_id = ?1 AND created_at >= ?2
     ORDER BY created_at DESC
     LIMIT 1000`
  )
    .bind(nodeId, cutoff)
    .all();
  return rows.results || [];
}

async function listDdnsRecords(env) {
  const rows = await env.DB.prepare(
    `SELECT d.hostname, d.node_id, n.name AS node_name, d.type, d.content, d.proxied, d.ttl, d.updated_at
     FROM ddns_records d
     LEFT JOIN nodes n ON n.id = d.node_id
     ORDER BY d.hostname ASC`
  ).all();
  return (rows.results || []).map((row) => ({
    ...row,
    proxied: Boolean(row.proxied),
  }));
}

async function listNotificationChannels(env, includeTarget = true) {
  const rows = await env.DB.prepare(
    "SELECT id, name, type, target, enabled, updated_at FROM notification_channels ORDER BY name ASC"
  ).all();
  return (rows.results || []).map((row) => ({
    ...row,
    target: includeTarget ? row.target : "",
    enabled: Boolean(row.enabled),
  }));
}

async function listNotificationLogs(env, limit) {
  const rows = await env.DB.prepare(
    `SELECT channel_id, scope_type, scope_id, level, title, body, success, response_text, created_at
     FROM notification_logs
     ORDER BY created_at DESC
     LIMIT ?1`
  )
    .bind(limit)
    .all();
  return (rows.results || []).map((row) => ({
    ...row,
    success: Boolean(row.success),
  }));
}

async function listUsers(env) {
  const rows = await env.DB.prepare(
    "SELECT id, username, role, permissions, enabled, created_at, updated_at FROM users ORDER BY username ASC"
  ).all();
  return (rows.results || []).map((row) => ({
    ...row,
    enabled: Boolean(row.enabled),
  }));
}

async function listApiTokens(env) {
  const rows = await env.DB.prepare(
    "SELECT id, name, role, permissions, enabled, created_by_user_id, last_used_at, created_at, updated_at FROM api_tokens ORDER BY name ASC"
  ).all();
  return (rows.results || []).map((row) => ({
    ...row,
    enabled: Boolean(row.enabled),
  }));
}

async function listAuditLogs(env, limit) {
  const rows = await env.DB.prepare(
    `SELECT actor_type, actor_id, actor_label, action, target_type, target_id, detail, created_at
     FROM audit_logs
     ORDER BY created_at DESC
     LIMIT ?1`
  )
    .bind(limit)
    .all();
  return rows.results || [];
}

async function listMonitorsForNode(env, nodeId) {
  const rows = await env.DB.prepare(
    `SELECT id, name, type, target, interval_sec, timeout_ms, expected_status, keyword, target_node_id
     FROM monitors
     WHERE enabled = 1
       AND (target_node_id = '' OR target_node_id = ?1)
     ORDER BY sort_order ASC, name ASC`
  )
    .bind(nodeId)
    .all();
  return rows.results || [];
}

async function listMonitorSummary(env) {
  const rows = await env.DB.prepare(
    `SELECT
      m.id,
      m.name,
      m.type,
      m.target,
      m.target_node_id,
      n.name AS node_name,
      m.interval_sec,
      m.timeout_ms,
      m.enabled,
      (
        SELECT status
        FROM monitor_results mr
        WHERE mr.monitor_id = m.id
        ORDER BY mr.created_at DESC
        LIMIT 1
      ) AS latest_status,
      (
        SELECT latency_ms
        FROM monitor_results mr
        WHERE mr.monitor_id = m.id
        ORDER BY mr.created_at DESC
        LIMIT 1
      ) AS latest_latency_ms,
      (
        SELECT detail
        FROM monitor_results mr
        WHERE mr.monitor_id = m.id
        ORDER BY mr.created_at DESC
        LIMIT 1
      ) AS latest_detail,
      (
        SELECT created_at
        FROM monitor_results mr
        WHERE mr.monitor_id = m.id
        ORDER BY mr.created_at DESC
        LIMIT 1
      ) AS latest_checked_at
    FROM monitors m
    LEFT JOIN nodes n ON n.id = m.target_node_id
    WHERE m.enabled = 1
    ORDER BY m.sort_order ASC, m.name ASC`
  ).all();
  return rows.results || [];
}

async function listMonitorHistory(env, monitorId, limit) {
  const rows = await env.DB.prepare(
    `SELECT monitor_id, node_id, status, latency_ms, detail, created_at
     FROM monitor_results
     WHERE monitor_id = ?1
     ORDER BY created_at DESC
     LIMIT ?2`
  )
    .bind(monitorId, limit)
    .all();
  return rows.results || [];
}

async function listTaskSummary(env, includeCommandText) {
  const rows = await env.DB.prepare(
    `SELECT
      t.id,
      t.name,
      t.type,
      t.command_text,
      t.target_node_id,
      n.name AS node_name,
      t.schedule_kind,
      t.interval_sec,
      t.enabled,
      t.run_once,
      t.next_run_at,
      t.last_run_at,
      (
        SELECT status
        FROM task_runs tr
        WHERE tr.task_id = t.id
        ORDER BY tr.created_at DESC
        LIMIT 1
      ) AS latest_status,
      (
        SELECT finished_at
        FROM task_runs tr
        WHERE tr.task_id = t.id
        ORDER BY tr.created_at DESC
        LIMIT 1
      ) AS latest_finished_at
    FROM tasks t
    LEFT JOIN nodes n ON n.id = t.target_node_id
    WHERE t.enabled = 1 OR t.next_run_at > 0
    ORDER BY t.updated_at DESC, t.name ASC`
  ).all();
  return (rows.results || []).map((row) => ({
    ...row,
    command_text: includeCommandText ? row.command_text : "",
  }));
}

async function listTaskRuns(env, taskId, limit, offset, query) {
  const like = `%${query}%`;
  const where = query
    ? `WHERE task_id = ?1 AND (status LIKE ?4 OR output LIKE ?4 OR node_id LIKE ?4)`
    : `WHERE task_id = ?1`;
  const rows = await env.DB.prepare(
    `SELECT id, task_id, node_id, status, output, exit_code, started_at, finished_at, created_at
     FROM task_runs
     ${where}
     ORDER BY created_at DESC
     LIMIT ?2 OFFSET ?3`
  )
    .bind(taskId, limit, offset, like)
    .all();
  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total
     FROM task_runs
     ${where}`
  )
    .bind(taskId, limit, offset, like)
    .first();
  return {
    runs: rows.results || [],
    total: Number(countRow?.total || 0),
    limit,
    offset,
    query,
  };
}

async function upsertHeartbeat(env, payload) {
  validateNodePayload(payload);
  const nodeId = payload.node_id;
  const nodeName = payload.node_name || nodeId;
  const existing = await env.DB.prepare(
    "SELECT token, group_id, location, public_note, private_note, hidden, ddns_enabled FROM nodes WHERE id = ?1"
  )
    .bind(nodeId)
    .first();
  const token = payload.node_token || existing?.token || crypto.randomUUID();
  const now = nowUnix();
  const metrics = payload.metrics || {};
  
  // 添加缺失的字段
  const heartbeatData = {
    ...payload,
    online: payload.status === 'online', // 根据status字段设置online状态
    timestamp: payload.timestamp || now // 使用payload中的timestamp或当前时间
  };

  await env.DB.prepare(
    `INSERT INTO nodes (
      id, name, token, group_id, tags, os, arch, version, location, public_note, private_note, hidden, ddns_enabled,
      public_ipv4, public_ipv6, private_ipv4, private_ipv6,
      cpu_cores, cpu_model, cpu_usage, process_count, tcp_conn_count, udp_conn_count,
      mem_total, mem_used, swap_total, swap_used, disk_total, disk_used,
      net_in_speed, net_out_speed, net_in_transfer, net_out_transfer,
      load_1, load_5, load_15, boot_time, last_seen, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34, ?35, ?36, ?37, ?38, ?39)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      tags = excluded.tags,
      os = excluded.os,
      arch = excluded.arch,
      version = excluded.version,
      public_ipv4 = excluded.public_ipv4,
      public_ipv6 = excluded.public_ipv6,
      private_ipv4 = excluded.private_ipv4,
      private_ipv6 = excluded.private_ipv6,
      cpu_cores = excluded.cpu_cores,
      cpu_model = excluded.cpu_model,
      cpu_usage = excluded.cpu_usage,
      process_count = excluded.process_count,
      tcp_conn_count = excluded.tcp_conn_count,
      udp_conn_count = excluded.udp_conn_count,
      mem_total = excluded.mem_total,
      mem_used = excluded.mem_used,
      swap_total = excluded.swap_total,
      swap_used = excluded.swap_used,
      disk_total = excluded.disk_total,
      disk_used = excluded.disk_used,
      net_in_speed = excluded.net_in_speed,
      net_out_speed = excluded.net_out_speed,
      net_in_transfer = excluded.net_in_transfer,
      net_out_transfer = excluded.net_out_transfer,
      load_1 = excluded.load_1,
      load_5 = excluded.load_5,
      load_15 = excluded.load_15,
      boot_time = excluded.boot_time,
      last_seen = excluded.last_seen,
      updated_at = excluded.updated_at`
  )
    .bind(
      nodeId,
      nodeName,
      token,
      existing?.group_id || null,
      joinTags(heartbeatData.tags),
      heartbeatData.platform?.os || "",
      heartbeatData.platform?.arch || "",
      heartbeatData.agent_version || "",
      existing?.location || "",
      existing?.public_note || "",
      existing?.private_note || "",
      Number(existing?.hidden || 0),
      Number(existing?.ddns_enabled ?? 1),
      heartbeatData.network?.public_ipv4 || "",
      heartbeatData.network?.public_ipv6 || "",
      heartbeatData.network?.private_ipv4 || "",
      heartbeatData.network?.private_ipv6 || "",
      Number(metrics.cpu_cores || 0),
      String(metrics.cpu_model || ""),
      Number(metrics.cpu_usage || 0),
      Number(metrics.process_count || 0),
      Number(metrics.tcp_conn_count || 0),
      Number(metrics.udp_conn_count || 0),
      Number(metrics.mem_total || 0),
      Number(metrics.mem_used || 0),
      Number(metrics.swap_total || 0),
      Number(metrics.swap_used || 0),
      Number(metrics.disk_total || 0),
      Number(metrics.disk_used || 0),
      Number(metrics.net_in_speed || 0),
      Number(metrics.net_out_speed || 0),
      Number(metrics.net_in_transfer || 0),
      Number(metrics.net_out_transfer || 0),
      Number(metrics.load_1 || 0),
      Number(metrics.load_5 || 0),
      Number(metrics.load_15 || 0),
      Number(metrics.boot_time || 0),
      heartbeatData.timestamp,
      now
    )
    .run();

  await env.DB.prepare(
    "INSERT INTO heartbeats (node_id, status, latency_ms, message, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
  )
    .bind(
      nodeId,
      heartbeatData.status || "online",
      Number(heartbeatData.latency_ms || 0),
      heartbeatData.message || "",
      JSON.stringify(heartbeatData),
      heartbeatData.timestamp
    )
    .run();

  await env.DB.prepare(
    `INSERT INTO resource_samples (
      node_id, cpu_usage, mem_usage_pct, swap_usage_pct, disk_usage_pct, load_1, load_5, load_15,
      process_count, tcp_conn_count, udp_conn_count, net_in_speed, net_out_speed, net_in_transfer, net_out_transfer, created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`
  )
    .bind(
      nodeId,
      Number(metrics.cpu_usage || 0),
      percentage(Number(metrics.mem_used || 0), Number(metrics.mem_total || 0)),
      percentage(Number(metrics.swap_used || 0), Number(metrics.swap_total || 0)),
      percentage(Number(metrics.disk_used || 0), Number(metrics.disk_total || 0)),
      Number(metrics.load_1 || 0),
      Number(metrics.load_5 || 0),
      Number(metrics.load_15 || 0),
      Number(metrics.process_count || 0),
      Number(metrics.tcp_conn_count || 0),
      Number(metrics.udp_conn_count || 0),
      Number(metrics.net_in_speed || 0),
      Number(metrics.net_out_speed || 0),
      Number(metrics.net_in_transfer || 0),
      Number(metrics.net_out_transfer || 0),
      heartbeatData.timestamp
    )
    .run();

  return { node_id: nodeId, node_token: token, last_seen: heartbeatData.timestamp };
}

async function updateDdnsRecord(env, payload) {
  if (!payload.hostname) {
    throw new Error("hostname is required");
  }
  if (!payload.content) {
    throw new Error("content is required");
  }
  if (!payload.node_id) {
    throw new Error("node_id is required");
  }

  const now = nowUnix();
  const type = payload.type || detectRecordType(payload.content);
  const zoneId = payload.zone_id || env.CF_ZONE_ID || "";
  const zoneName = payload.zone_name || env.CF_ZONE_NAME || "";
  let upstream = null;

  if (env.CF_API_TOKEN && zoneId) {
    upstream = await syncCloudflareDns(env, {
      hostname: payload.hostname,
      type,
      content: payload.content,
      proxied: payload.proxied ? 1 : 0,
      ttl: Number(payload.ttl || 60),
      zone_id: zoneId,
      comment: payload.comment || "",
    });
  }

  await env.DB.prepare(
    `INSERT INTO ddns_records (
      hostname, node_id, type, content, proxied, ttl, zone_id, zone_name, comment, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
    ON CONFLICT(hostname) DO UPDATE SET
      node_id = excluded.node_id,
      type = excluded.type,
      content = excluded.content,
      proxied = excluded.proxied,
      ttl = excluded.ttl,
      zone_id = excluded.zone_id,
      zone_name = excluded.zone_name,
      comment = excluded.comment,
      updated_at = excluded.updated_at`
  )
    .bind(
      payload.hostname,
      payload.node_id,
      type,
      payload.content,
      payload.proxied ? 1 : 0,
      Number(payload.ttl || 60),
      zoneId,
      zoneName,
      payload.comment || "",
      now
    )
    .run();

  return {
    hostname: payload.hostname,
    content: payload.content,
    type,
    zone_id: zoneId,
    updated_at: now,
    upstream,
  };
}

async function insertMonitorResult(env, payload) {
  if (!payload.monitor_id || !payload.node_id) {
    throw new Error("monitor_id and node_id are required");
  }
  const now = nowUnix();
  await env.DB.prepare(
    "INSERT INTO monitor_results (monitor_id, node_id, status, latency_ms, detail, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
  )
    .bind(
      payload.monitor_id,
      payload.node_id,
      payload.status || "down",
      Number(payload.latency_ms || 0),
      payload.detail || "",
      now
    )
    .run();
  await processMonitorAlert(env, payload.monitor_id, payload.status || "down", payload.detail || "", Number(payload.latency_ms || 0));
  return { monitor_id: payload.monitor_id, created_at: now };
}

async function dispatchDueTasks(env, nodeId) {
  const now = nowUnix();
  const rows = await env.DB.prepare(
    `SELECT id, name, type, command_text, schedule_kind, interval_sec, run_once, next_run_at
     FROM tasks
     WHERE enabled = 1
       AND next_run_at > 0
       AND next_run_at <= ?1
       AND (target_node_id = '' OR target_node_id = ?2)
     ORDER BY next_run_at ASC
     LIMIT 10`
  )
    .bind(now, nodeId)
    .all();

  const tasks = rows.results || [];
  const dispatched = [];

  for (const task of tasks) {
    const insertRun = await env.DB.prepare(
      "INSERT INTO task_runs (task_id, node_id, status, started_at, created_at, updated_at) VALUES (?1, ?2, 'running', ?3, ?3, ?3)"
    )
      .bind(task.id, nodeId, now)
      .run();
    const runId = insertRun.meta?.last_row_id || 0;

    const nextRunAt =
      Number(task.interval_sec || 0) > 0 ? now + Number(task.interval_sec) : 0;
    await env.DB.prepare(
      `UPDATE tasks
       SET last_run_at = ?2,
           next_run_at = ?3,
           enabled = CASE WHEN run_once = 1 AND ?3 = 0 THEN 0 ELSE enabled END,
           updated_at = ?2
       WHERE id = ?1`
    )
      .bind(task.id, now, nextRunAt)
      .run();

    dispatched.push({
      run_id: runId,
      task_id: task.id,
      name: task.name,
      type: task.type,
      command_text: task.command_text,
    });
  }

  return dispatched;
}

async function completeTaskRun(env, payload) {
  if (!payload.run_id || !payload.node_id) {
    throw new Error("run_id and node_id are required");
  }
  const now = nowUnix();
  await env.DB.prepare(
    `UPDATE task_runs
     SET status = ?2,
         output = ?3,
         exit_code = ?4,
         finished_at = ?5,
         updated_at = ?5
     WHERE id = ?1 AND node_id = ?6`
  )
    .bind(
      payload.run_id,
      payload.status || "failed",
      String(payload.output || "").slice(0, 65535),
      Number(payload.exit_code || 0),
      now,
      payload.node_id
    )
    .run();
  await processTaskAlert(env, payload.run_id, payload.node_id, payload.status || "failed", String(payload.output || "").slice(0, 500));
  return { run_id: payload.run_id, finished_at: now };
}

async function upsertNotificationChannel(env, payload) {
  const id = payload.id || slugify(payload.name);
  if (!id || !payload.name || !payload.type || !payload.target) {
    throw new Error("id/name/type/target are required");
  }
  const now = nowUnix();
  await env.DB.prepare(
    `INSERT INTO notification_channels (id, name, type, target, enabled, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       type = excluded.type,
       target = excluded.target,
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`
  )
    .bind(id, payload.name, payload.type, payload.target, payload.enabled === false ? 0 : 1, now)
    .run();
  return { id, updated_at: now };
}

async function upsertUser(env, payload) {
  const id = payload.id || slugify(payload.username);
  if (!id || !payload.username || !payload.role) {
    throw new Error("id/username/role are required");
  }
  const now = nowUnix();
  const existing = await env.DB.prepare(
    "SELECT password_hash FROM users WHERE id = ?1"
  )
    .bind(id)
    .first();
  const passwordHash = payload.password
    ? await sha256Hex(String(payload.password))
    : existing?.password_hash;
  if (!passwordHash) {
    throw new Error("password is required for new users");
  }
  await env.DB.prepare(
    `INSERT INTO users (id, username, password_hash, role, permissions, enabled, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
     ON CONFLICT(id) DO UPDATE SET
       username = excluded.username,
       password_hash = excluded.password_hash,
       role = excluded.role,
       permissions = excluded.permissions,
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`
  )
    .bind(
      id,
      payload.username,
      passwordHash,
      normalizeRole(payload.role),
      normalizePermissions(payload.permissions),
      payload.enabled === false ? 0 : 1,
      now
    )
    .run();
  return { id, updated_at: now };
}

async function upsertApiToken(env, payload, auth) {
  const id = payload.id || slugify(payload.name);
  if (!id || !payload.name || !payload.role) {
    throw new Error("id/name/role are required");
  }
  const now = nowUnix();
  const existing = await env.DB.prepare("SELECT token_hash FROM api_tokens WHERE id = ?1")
    .bind(id)
    .first();
  const rawToken = payload.token || (existing ? "" : crypto.randomUUID());
  const tokenHash = rawToken ? await sha256Hex(String(rawToken)) : existing?.token_hash;
  if (!tokenHash) {
    throw new Error("token is required for new api tokens");
  }
  await env.DB.prepare(
    `INSERT INTO api_tokens (id, name, token_hash, role, permissions, enabled, created_by_user_id, last_used_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?8)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       token_hash = excluded.token_hash,
       role = excluded.role,
       permissions = excluded.permissions,
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`
  )
    .bind(
      id,
      payload.name,
      tokenHash,
      normalizeRole(payload.role),
      normalizePermissions(payload.permissions),
      payload.enabled === false ? 0 : 1,
      auth.user_id || "",
      now
    )
    .run();
  return { id, name: payload.name, token: rawToken || undefined, updated_at: now };
}

async function setEntityEnabled(env, entityType, id, enabled) {
  const map = {
    user: ["users", "enabled"],
    api_token: ["api_tokens", "enabled"],
    monitor: ["monitors", "enabled"],
    task: ["tasks", "enabled"],
    notification_channel: ["notification_channels", "enabled"],
  };
  const entry = map[String(entityType || "")];
  if (!entry) {
    throw new Error("unsupported entity_type");
  }
  const [table, field] = entry;
  await env.DB.prepare(`UPDATE ${table} SET ${field} = ?2, updated_at = ?3 WHERE id = ?1`)
    .bind(id, enabled ? 1 : 0, nowUnix())
    .run();
  return { id, entity_type: entityType, enabled };
}

async function deleteEntity(env, entityType, id) {
  const map = {
    group: "node_groups",
    user: "users",
    api_token: "api_tokens",
    monitor: "monitors",
    task: "tasks",
    notification_channel: "notification_channels",
  };
  const table = map[String(entityType || "")];
  if (!table) {
    throw new Error("unsupported entity_type");
  }
  await env.DB.prepare(`DELETE FROM ${table} WHERE id = ?1`).bind(id).run();
  return { id, entity_type: entityType, deleted: true };
}

function permissionForEntityAdminAction(entityType) {
  const map = {
    group: "groups.manage",
    user: "access.manage",
    api_token: "access.manage",
    monitor: "monitors.manage",
    task: "tasks.manage",
    notification_channel: "alerts.manage",
  };
  const permission = map[String(entityType || "")];
  if (!permission) {
    throw new Error("unsupported entity_type");
  }
  return permission;
}

async function writeAuditLog(env, auth, action, targetType, targetId, detail) {
  await env.DB.prepare(
    `INSERT INTO audit_logs (
      actor_type, actor_id, actor_label, action, target_type, target_id, detail, created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
  )
    .bind(
      auth.mode || "unknown",
      auth.user_id || auth.username || auth.token_id || "unknown",
      auth.username || auth.token_name || "unknown",
      action,
      targetType,
      targetId,
      String(detail || ""),
      nowUnix()
    )
    .run();
}

async function loginWithPassword(env, username, password) {
  if (!username || !password) {
    throw new Error("username and password are required");
  }
  const user = await env.DB.prepare(
    "SELECT id, username, password_hash, role, permissions, enabled FROM users WHERE username = ?1"
  )
    .bind(String(username))
    .first();
  if (!user || !Boolean(user.enabled)) {
    throw new Error("invalid credentials");
  }
  const hashed = await sha256Hex(String(password));
  if (hashed !== user.password_hash) {
    throw new Error("invalid credentials");
  }
  const sessionToken = crypto.randomUUID();
  const maxAgeSec = 60 * 60 * 24 * 7;
  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)"
  )
    .bind(sessionToken, user.id, nowUnix() + maxAgeSec, nowUnix())
    .run();
  return {
    sessionToken,
    maxAgeSec,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      permissions: expandPermissions(user.role, user.permissions),
    },
  };
}

async function getAlertPolicy(env) {
  const row = await env.DB.prepare(
    "SELECT value FROM app_settings WHERE key = 'alert_policy'"
  ).first();
  const defaults = {
    quiet_hours_start: "",
    quiet_hours_end: "",
    timezone_offset_minutes: 480,
    resend_interval_sec: 1800,
    monitor_fail_threshold: 1,
    task_fail_threshold: 1,
  };
  if (!row?.value) {
    return defaults;
  }
  try {
    return { ...defaults, ...JSON.parse(row.value) };
  } catch {
    return defaults;
  }
}

async function upsertAlertPolicy(env, payload) {
  const policy = {
    quiet_hours_start: String(payload.quiet_hours_start || ""),
    quiet_hours_end: String(payload.quiet_hours_end || ""),
    timezone_offset_minutes: Number(payload.timezone_offset_minutes ?? 480),
    resend_interval_sec: Number(payload.resend_interval_sec || 1800),
    monitor_fail_threshold: Number(payload.monitor_fail_threshold || 1),
    task_fail_threshold: Number(payload.task_fail_threshold || 1),
  };
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ('alert_policy', ?1, ?2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(JSON.stringify(policy), nowUnix())
    .run();
  return policy;
}

async function getWebSocketSettings(env) {
  const row = await env.DB.prepare(
    "SELECT value FROM app_settings WHERE key = 'websocket_config'"
  ).first();
  
  if (!row) {
    // 返回默认设置
    return {
      enabled: true,
      max_connections: 100,
      heartbeat_interval: 30,
      ping_interval: 30,
      reconnect_interval: 10,
      connection_timeout: 60
    };
  }
  
  try {
    return JSON.parse(row.value);
  } catch {
    return {
      enabled: true,
      max_connections: 100,
      heartbeat_interval: 30,
      ping_interval: 30,
      reconnect_interval: 10,
      connection_timeout: 60
    };
  }
}

async function upsertWebSocketSettings(env, payload) {
  const settings = {
    enabled: Boolean(payload.enabled ?? true),
    max_connections: Number(payload.max_connections ?? 100),
    heartbeat_interval: Number(payload.heartbeat_interval ?? 30),
    ping_interval: Number(payload.ping_interval ?? 30),
    reconnect_interval: Number(payload.reconnect_interval ?? 10),
    connection_timeout: Number(payload.connection_timeout ?? 60),
  };
  
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ('websocket_config', ?1, ?2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(JSON.stringify(settings), nowUnix())
    .run();
  
  return settings;
}

async function upsertGroup(env, payload) {
  const id = payload.id || slugify(payload.name);
  if (!id || !payload.name) {
    throw new Error("group id and name are required");
  }
  const now = nowUnix();
  await env.DB.prepare(
    `INSERT INTO node_groups (id, name, description, sort_order, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       sort_order = excluded.sort_order,
       updated_at = excluded.updated_at`
  )
    .bind(id, payload.name, payload.description || "", Number(payload.sort_order || 0), now)
    .run();
  return { id, updated_at: now };
}

async function upsertServerConfig(env, payload) {
  if (!payload.node_id) {
    throw new Error("node_id is required");
  }
  const now = nowUnix();
  await env.DB.prepare(
    `UPDATE nodes
     SET group_id = ?2,
         location = ?3,
         public_note = ?4,
         private_note = ?5,
         hidden = ?6,
         ddns_enabled = ?7,
         updated_at = ?8
     WHERE id = ?1`
  )
    .bind(
      payload.node_id,
      payload.group_id || "",
      payload.location || "",
      payload.public_note || "",
      payload.private_note || "",
      payload.hidden ? 1 : 0,
      payload.ddns_enabled === false ? 0 : 1,
      now
    )
    .run();
  return { node_id: payload.node_id, updated_at: now };
}

async function rotateServerToken(env, nodeId) {
  const token = crypto.randomUUID();
  await env.DB.prepare("UPDATE nodes SET token = ?2, updated_at = ?3 WHERE id = ?1")
    .bind(nodeId, token, nowUnix())
    .run();
  return { node_id: nodeId, token };
}

async function upsertMonitor(env, payload) {
  const id = payload.id || slugify(payload.name);
  if (!id || !payload.name || !payload.type || !payload.target) {
    throw new Error("id/name/type/target are required");
  }
  const now = nowUnix();
  await env.DB.prepare(
    `INSERT INTO monitors (
      id, name, type, target, target_node_id, interval_sec, timeout_ms, expected_status, keyword,
      enabled, sort_order, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      type = excluded.type,
      target = excluded.target,
      target_node_id = excluded.target_node_id,
      interval_sec = excluded.interval_sec,
      timeout_ms = excluded.timeout_ms,
      expected_status = excluded.expected_status,
      keyword = excluded.keyword,
      enabled = excluded.enabled,
      sort_order = excluded.sort_order,
      updated_at = excluded.updated_at`
  )
    .bind(
      id,
      payload.name,
      payload.type,
      payload.target,
      payload.target_node_id || "",
      Number(payload.interval_sec || 60),
      Number(payload.timeout_ms || 5000),
      Number(payload.expected_status || 200),
      payload.keyword || "",
      payload.enabled === false ? 0 : 1,
      Number(payload.sort_order || 0),
      now
    )
    .run();
  return { id, updated_at: now };
}

async function upsertTask(env, payload) {
  const id = payload.id || slugify(payload.name);
  if (!id || !payload.name || !payload.command_text) {
    throw new Error("id/name/command_text are required");
  }
  const now = nowUnix();
  const scheduleKind = payload.schedule_kind || "manual";
  const intervalSec = Number(payload.interval_sec || 0);
  const nextRunAt =
    scheduleKind === "interval" && intervalSec > 0
      ? Number(payload.next_run_at || now)
      : Number(payload.next_run_at || 0);

  await env.DB.prepare(
    `INSERT INTO tasks (
      id, name, type, command_text, target_node_id, schedule_kind, interval_sec,
      enabled, run_once, next_run_at, last_run_at, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, ?11, ?11)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      type = excluded.type,
      command_text = excluded.command_text,
      target_node_id = excluded.target_node_id,
      schedule_kind = excluded.schedule_kind,
      interval_sec = excluded.interval_sec,
      enabled = excluded.enabled,
      run_once = excluded.run_once,
      next_run_at = excluded.next_run_at,
      updated_at = excluded.updated_at`
  )
    .bind(
      id,
      payload.name,
      payload.type || "command",
      payload.command_text,
      payload.target_node_id || "",
      scheduleKind,
      intervalSec,
      payload.enabled === false ? 0 : 1,
      payload.run_once ? 1 : 0,
      nextRunAt,
      now
    )
    .run();
  return { id, updated_at: now };
}

async function triggerTask(env, taskId) {
  if (!taskId) {
    throw new Error("task_id is required");
  }
  const now = nowUnix();
  await env.DB.prepare(
    "UPDATE tasks SET next_run_at = ?2, enabled = 1, updated_at = ?2 WHERE id = ?1"
  )
    .bind(taskId, now)
    .run();
  return { task_id: taskId, next_run_at: now };
}

async function processMonitorAlert(env, monitorId, rawStatus, detail, latencyMs) {
  const monitor = await env.DB.prepare("SELECT id, name, target FROM monitors WHERE id = ?1")
    .bind(monitorId)
    .first();
  if (!monitor) {
    return;
  }
  const status = rawStatus === "up" ? "healthy" : "failing";
  const policy = await getAlertPolicy(env);
  const failThreshold = Math.max(Number(policy.monitor_fail_threshold || 1), 1);
  const previous = await getAlertState(env, "monitor", monitorId);
  if (status === "failing") {
    const consecutive = await countConsecutiveMonitorFailures(env, monitorId);
    if (consecutive < failThreshold) {
      return;
    }
  }
  if (previous?.status === status && !(await shouldResendAlert(env, previous))) {
    return;
  }
  const level = status === "healthy" ? "info" : "error";
  const title = status === "healthy"
    ? `Monitor recovered: ${monitor.name}`
    : `Monitor failed: ${monitor.name}`;
  const body = [
    `Target: ${monitor.target}`,
    `Status: ${rawStatus}`,
    `Latency: ${latencyMs} ms`,
    detail ? `Detail: ${detail}` : "",
  ].filter(Boolean).join("\n");
  await notifyAllChannels(env, {
    scopeType: "monitor",
    scopeId: monitorId,
    level,
    title,
    body,
  });
  await setAlertState(env, "monitor", monitorId, status, detail);
}

async function processTaskAlert(env, runId, nodeId, status, output) {
  const run = await env.DB.prepare(
    `SELECT tr.task_id, t.name, t.command_text
     FROM task_runs tr
     LEFT JOIN tasks t ON t.id = tr.task_id
     WHERE tr.id = ?1`
  )
    .bind(runId)
    .first();
  if (!run) {
    return;
  }
  const normalized = status === "success" ? "healthy" : "failing";
  const policy = await getAlertPolicy(env);
  const failThreshold = Math.max(Number(policy.task_fail_threshold || 1), 1);
  const scopeId = `${run.task_id}:${nodeId}`;
  const previous = await getAlertState(env, "task", scopeId);
  if (normalized === "failing") {
    const consecutive = await countConsecutiveTaskFailures(env, run.task_id, nodeId);
    if (consecutive < failThreshold) {
      return;
    }
  }
  if (previous?.status === normalized && !(await shouldResendAlert(env, previous))) {
    return;
  }
  const title = normalized === "healthy"
    ? `Task recovered: ${run.name}`
    : `Task failed: ${run.name}`;
  const body = [
    `Node: ${nodeId}`,
    `Status: ${status}`,
    `Command: ${run.command_text}`,
    output ? `Output: ${output}` : "",
  ].filter(Boolean).join("\n");
  await notifyAllChannels(env, {
    scopeType: "task",
    scopeId,
    level: normalized === "healthy" ? "info" : "error",
    title,
    body,
  });
  await setAlertState(env, "task", scopeId, normalized, output);
}

async function processOfflineAlerts(env) {
  const cutoff = nowUnix() - getHeartbeatTimeoutSec(env);
  const rows = await env.DB.prepare(
    "SELECT id, name, last_seen FROM nodes"
  ).all();
  let processed = 0;
  for (const node of rows.results || []) {
    const offline = Number(node.last_seen || 0) < cutoff;
    const status = offline ? "failing" : "healthy";
    const previous = await getAlertState(env, "node", node.id);
    if (previous?.status === status && !(await shouldResendAlert(env, previous))) {
      continue;
    }
    const title = offline ? `Node offline: ${node.name}` : `Node recovered: ${node.name}`;
    const body = [
      `Node: ${node.id}`,
      `Last seen: ${node.last_seen || 0}`,
      `Timeout sec: ${getHeartbeatTimeoutSec(env)}`,
    ].join("\n");
    await notifyAllChannels(env, {
      scopeType: "node",
      scopeId: node.id,
      level: offline ? "error" : "info",
      title,
      body,
    });
    await setAlertState(env, "node", node.id, status, body);
    processed += 1;
  }
  return { processed };
}

async function countConsecutiveMonitorFailures(env, monitorId) {
  const rows = await env.DB.prepare(
    `SELECT status
     FROM monitor_results
     WHERE monitor_id = ?1
     ORDER BY created_at DESC
     LIMIT 20`
  )
    .bind(monitorId)
    .all();
  let count = 0;
  for (const row of rows.results || []) {
    if (row.status === "up") {
      break;
    }
    count += 1;
  }
  return count;
}

async function countConsecutiveTaskFailures(env, taskId, nodeId) {
  const rows = await env.DB.prepare(
    `SELECT status
     FROM task_runs
     WHERE task_id = ?1 AND node_id = ?2
     ORDER BY created_at DESC
     LIMIT 20`
  )
    .bind(taskId, nodeId)
    .all();
  let count = 0;
  for (const row of rows.results || []) {
    if (row.status === "success") {
      break;
    }
    if (row.status === "failed" || row.status === "timeout") {
      count += 1;
      continue;
    }
    break;
  }
  return count;
}

async function getAlertState(env, scopeType, scopeId) {
  return env.DB.prepare(
    "SELECT scope_type, scope_id, status, detail, last_sent_at, updated_at FROM alert_states WHERE scope_type = ?1 AND scope_id = ?2"
  )
    .bind(scopeType, scopeId)
    .first();
}

async function setAlertState(env, scopeType, scopeId, status, detail) {
  const now = nowUnix();
  await env.DB.prepare(
    `INSERT INTO alert_states (scope_type, scope_id, status, detail, last_sent_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5)
     ON CONFLICT(scope_type, scope_id) DO UPDATE SET
       status = excluded.status,
       detail = excluded.detail,
       last_sent_at = excluded.last_sent_at,
       updated_at = excluded.updated_at`
  )
    .bind(scopeType, scopeId, status, detail || "", now)
    .run();
}

async function notifyAllChannels(env, message) {
  if (await isAlertMuted(env)) {
    return;
  }
  const dbChannels = await listNotificationChannels(env);
  const envChannels = buildEnvNotificationChannels(env);
  const channels = [...dbChannels, ...envChannels].filter((channel) => channel.enabled);
  for (const channel of channels) {
    const result = await sendNotification(env, channel, message);
    await env.DB.prepare(
      `INSERT INTO notification_logs (
        channel_id, scope_type, scope_id, level, title, body, success, response_text, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    )
      .bind(
        channel.id,
        message.scopeType,
        message.scopeId,
        message.level,
        message.title,
        message.body,
        result.success ? 1 : 0,
        result.responseText || "",
        nowUnix()
      )
      .run();
  }
}

async function shouldResendAlert(env, previous) {
  const policy = await getAlertPolicy(env);
  const resendInterval = Number(policy.resend_interval_sec || 0);
  if (resendInterval <= 0) {
    return false;
  }
  return Number(previous?.last_sent_at || 0) + resendInterval <= nowUnix();
}

async function isAlertMuted(env) {
  const policy = await getAlertPolicy(env);
  const start = String(policy.quiet_hours_start || "");
  const end = String(policy.quiet_hours_end || "");
  if (!start || !end) {
    return false;
  }
  const current = currentMinutesInPolicyTimezone(Number(policy.timezone_offset_minutes || 0));
  const startMinutes = parseClockMinutes(start);
  const endMinutes = parseClockMinutes(end);
  if (startMinutes === null || endMinutes === null) {
    return false;
  }
  if (startMinutes === endMinutes) {
    return false;
  }
  if (startMinutes < endMinutes) {
    return current >= startMinutes && current < endMinutes;
  }
  return current >= startMinutes || current < endMinutes;
}

function parseClockMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }
  return hours * 60 + minutes;
}

function currentMinutesInPolicyTimezone(offsetMinutes) {
  const now = new Date(Date.now() + offsetMinutes * 60000);
  return now.getUTCHours() * 60 + now.getUTCMinutes();
}

function buildEnvNotificationChannels(env) {
  const channels = [];
  if (env.ALERT_WEBHOOK_URL) {
    channels.push({
      id: "env-webhook",
      name: "Environment Webhook",
      type: "webhook",
      target: env.ALERT_WEBHOOK_URL,
      enabled: true,
    });
  }
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    channels.push({
      id: "env-telegram",
      name: "Environment Telegram",
      type: "telegram",
      target: `${env.TELEGRAM_BOT_TOKEN}:${env.TELEGRAM_CHAT_ID}`,
      enabled: true,
    });
  }
  return channels;
}

async function sendNotification(env, channel, message) {
  try {
    if (channel.type === "webhook") {
      const res = await fetch(channel.target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          level: message.level,
          title: message.title,
          body: message.body,
          scope_type: message.scopeType,
          scope_id: message.scopeId,
        }),
      });
      return { success: res.ok, responseText: await safeResponseText(res) };
    }
    if (channel.type === "telegram") {
      const [botToken, chatId] = String(channel.target).split(":");
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: `${message.title}\n${message.body}`,
        }),
      });
      return { success: res.ok, responseText: await safeResponseText(res) };
    }
    return { success: false, responseText: "unsupported channel type" };
  } catch (error) {
    return {
      success: false,
      responseText: error instanceof Error ? error.message : String(error),
    };
  }
}

async function safeResponseText(response) {
  try {
    return (await response.text()).slice(0, 1000);
  } catch {
    return "";
  }
}

async function syncCloudflareDns(env, record) {
  const endpoint = `https://api.cloudflare.com/client/v4/zones/${record.zone_id}/dns_records`;
  const headers = {
    authorization: `Bearer ${env.CF_API_TOKEN}`,
    "content-type": "application/json",
  };

  const existingRes = await fetch(
    `${endpoint}?type=${encodeURIComponent(record.type)}&name=${encodeURIComponent(record.hostname)}`,
    { headers }
  );
  if (!existingRes.ok) {
    throw new Error(`cloudflare lookup failed: ${existingRes.status}`);
  }
  const existingJson = await existingRes.json();
  const existing = existingJson?.result?.[0];

  const body = {
    type: record.type,
    name: record.hostname,
    content: record.content,
    ttl: record.ttl,
    proxied: Boolean(record.proxied),
    comment: record.comment || undefined,
  };

  const response = existing?.id
    ? await fetch(`${endpoint}/${existing.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(body),
      })
    : await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

  if (!response.ok) {
    throw new Error(`cloudflare upsert failed: ${response.status} ${await response.text()}`);
  }

  const result = await response.json();
  return {
    record_id: result?.result?.id || "",
    proxied: result?.result?.proxied || false,
  };
}

async function verifyAgentRequest(request, env, nodeId) {
  // 对于WebSocket连接，从查询参数获取token
  let token;
  if (request.method === "GET" && new URL(request.url).searchParams.has("token")) {
    token = new URL(request.url).searchParams.get("token");
  } else {
    // 对于HTTP请求，从Authorization header获取token
    token = bearerToken(request);
  }
  
  if (!token) {
    throw new Error("missing token");
  }
  
  // 检查是否是共享密钥
  if (token === env.AGENT_SHARED_SECRET) {
    return true;
  }
  
  // 检查节点特定token
  if (!nodeId) {
    throw new Error("node_id required for node token auth");
  }
  
  const row = await env.DB.prepare("SELECT token FROM nodes WHERE id = ?1")
    .bind(nodeId)
    .first();
  
  if (!row || row.token !== token) {
    throw new Error("invalid token");
  }
  
  return true;
}

async function requirePermission(request, env, permission) {
  const auth = await getRequestAuth(request, env);
  if (!hasPermission(auth.permissions || [], permission)) {
    throw new Error("insufficient permissions");
  }
  return auth;
}

async function getRequestAuth(request, env) {
  // 首先尝试从Authorization header获取token
  const token = bearerToken(request);
  if (token && token === env.ADMIN_SHARED_SECRET) {
    return {
      authenticated: true,
      mode: "token",
      role: "admin",
      username: "admin-token",
      permissions: expandPermissions("admin", "*"),
    };
  }
  
  // 如果header中没有token，尝试从查询参数获取
  const url = new URL(request.url);
  const queryToken = url.searchParams.get('token');
  if (queryToken && queryToken === env.ADMIN_SHARED_SECRET) {
    return {
      authenticated: true,
      mode: "token",
      role: "admin",
      username: "admin-token",
      permissions: expandPermissions("admin", "*"),
    };
  }
  if (token) {
    const tokenHash = await sha256Hex(token);
    const apiToken = await env.DB.prepare(
      "SELECT id, name, role, permissions, enabled FROM api_tokens WHERE token_hash = ?1"
    )
      .bind(tokenHash)
      .first();
    if (apiToken && Boolean(apiToken.enabled)) {
      await env.DB.prepare("UPDATE api_tokens SET last_used_at = ?2, updated_at = ?2 WHERE id = ?1")
        .bind(apiToken.id, nowUnix())
        .run();
      return {
        authenticated: true,
        mode: "api_token",
        role: normalizeRole(apiToken.role),
        username: apiToken.name,
        token_id: apiToken.id,
        token_name: apiToken.name,
        permissions: expandPermissions(apiToken.role, apiToken.permissions),
      };
    }
  }
  const sessionId = readCookie(request, "session_token");
  if (!sessionId) {
    return { authenticated: false, mode: "anonymous", role: "anonymous", permissions: [] };
  }
  const row = await env.DB.prepare(
    `SELECT s.id AS session_id, s.expires_at, u.id AS user_id, u.username, u.role, u.permissions, u.enabled
     FROM sessions s
     LEFT JOIN users u ON u.id = s.user_id
     WHERE s.id = ?1`
  )
    .bind(sessionId)
    .first();
  if (!row || !row.user_id || !Boolean(row.enabled) || Number(row.expires_at || 0) < nowUnix()) {
    if (row?.session_id) {
      await env.DB.prepare("DELETE FROM sessions WHERE id = ?1").bind(sessionId).run();
    }
    return { authenticated: false, mode: "anonymous", role: "anonymous", permissions: [] };
  }
  return {
    authenticated: true,
    mode: "session",
    role: normalizeRole(row.role),
    username: row.username,
    user_id: row.user_id,
    session_id: row.session_id,
    permissions: expandPermissions(row.role, row.permissions),
  };
}

function bearerToken(request) {
  const header = request.headers.get("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function readCookie(request, name) {
  const cookie = request.headers.get("cookie") || "";
  for (const pair of cookie.split(";")) {
    const [key, ...rest] = pair.trim().split("=");
    if (key === name) {
      return decodeURIComponent(rest.join("="));
    }
  }
  return "";
}

function makeSessionCookie(token, maxAgeSec) {
  return `session_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

function defaultPermissionsForRole(role) {
  const normalized = normalizeRole(role);
  if (normalized === "admin") {
    return ["*"];
  }
  if (normalized === "operator") {
    return [
      "dashboard.read",
      "servers.read",
      "groups.read",
      "monitors.read",
      "tasks.read",
      "tasks.run",
      "alerts.read",
      "alerts.run",
      "audit.read",
    ];
  }
  if (normalized === "viewer") {
    return [
      "dashboard.read",
      "servers.read",
      "groups.read",
      "monitors.read",
      "tasks.read",
      "alerts.read",
    ];
  }
  return [];
}

function normalizePermissions(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean).join(",");
  }
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .join(",");
}

function expandPermissions(role, extra) {
  const merged = new Set(defaultPermissionsForRole(role));
  for (const item of String(extra || "").split(",")) {
    const permission = item.trim();
    if (permission) {
      merged.add(permission);
    }
  }
  return Array.from(merged);
}

function hasPermission(permissions, required) {
  return permissions.includes("*") || permissions.includes(required);
}

function normalizeRole(value) {
  const role = String(value || "").toLowerCase();
  return ["viewer", "operator", "admin"].includes(role) ? role : "viewer";
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function validateNodePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("invalid JSON body");
  }
  if (!payload.node_id) {
    throw new Error("node_id is required");
  }
}

async function cachedJson(env, ctx, key, ttl, factory) {
  const cached = await env.CACHE.get(key);
  if (cached) {
    return new Response(cached, { headers: JSON_HEADERS });
  }
  const value = await factory();
  const body = JSON.stringify(value);
  ctx.waitUntil(env.CACHE.put(key, body, { expirationTtl: ttl }));
  return new Response(body, { headers: JSON_HEADERS });
}

async function clearDashboardCache(env, origin) {
  await env.CACHE.delete(`${origin}/cache/dashboard`);
}

function renderDashboardHtml(env) {
  const title = escapeHtml(env.DASHBOARD_TITLE || "Server Status");
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      :root {
        --bg: #000000;
        --card-bg: #1a1a1a;
        --border: #333333;
        --text-primary: #ffffff;
        --text-secondary: #cccccc;
        --text-muted: #888888;
        --accent-blue: #007bff;
        --accent-green: #28a745;
        --accent-red: #dc3545;
        --online: #00c851;
        --offline: #ff4444;
        --radius: 12px;
        --shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      }
      
      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }
      
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        background: var(--bg);
        color: var(--text-primary);
        line-height: 1.6;
        min-height: 100vh;
      }
      
      .container {
        max-width: 1000px;
        margin: 0 auto;
        padding: 15px;
      }
      
      /* Header */
      .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 20px;
        padding: 0 8px;
      }
      
      .logo {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 16px;
        font-weight: 600;
      }
      
      .logo-icon {
        width: 32px;
        height: 32px;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        border-radius: var(--radius);
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
        font-weight: bold;
        font-size: 16px;
      }
      
      .logo-text {
        display: flex;
        flex-direction: column;
      }
      
      .logo-text .main {
        font-size: 16px;
        font-weight: 600;
      }
      
      .logo-text .sub {
        font-size: 11px;
        color: var(--text-muted);
      }
      
      .nav-icons {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      
      .nav-icon {
        width: 30px;
        height: 30px;
        border-radius: 50%;
        background: var(--card-bg);
        border: 1px solid var(--border);
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: all 0.2s;
      }
      
      .nav-icon svg {
        width: 16px;
        height: 16px;
        fill: var(--text-secondary);
      }
      
      .nav-icon:hover {
        background: #2a2a2a;
      }
      
      .online-indicator {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        background: var(--card-bg);
        border: 1px solid var(--border);
        border-radius: 16px;
        font-size: 12px;
      }
      
      .online-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--online);
      }
      
      /* Overview Cards */
      .overview-section {
        margin-bottom: 20px;
      }
      
      .overview-title {
        font-size: 14px;
        color: var(--text-secondary);
        margin-bottom: 10px;
      }
      
      .overview-time {
        font-size: 12px;
        color: var(--text-muted);
        margin-bottom: 15px;
      }
      
      .overview-cards {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 15px;
        margin-bottom: 20px;
      }
      
      .overview-card {
        background: var(--card-bg);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        padding: 15px;
        position: relative;
        overflow: hidden;
      }
      
      .overview-card.highlight {
        border-color: var(--accent-blue);
      }
      
      .overview-card-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 10px;
      }
      
      .overview-card-title {
        font-size: 12px;
        color: var(--text-secondary);
        font-weight: 500;
      }
      
      .overview-card-icon {
        width: 20px;
        height: 20px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      
      .overview-card-icon svg {
        width: 12px;
        height: 12px;
      }
      
      .icon-blue { background: rgba(0, 123, 255, 0.2); }
      .icon-blue svg { fill: var(--accent-blue); }
      .icon-green { background: rgba(40, 167, 69, 0.2); }
      .icon-green svg { fill: var(--accent-green); }
      .icon-red { background: rgba(220, 53, 69, 0.2); }
      .icon-red svg { fill: var(--accent-red); }
      .icon-purple { background: rgba(102, 126, 234, 0.2); }
      .icon-purple svg { fill: #667eea; }
      
      .overview-card-value {
        font-size: 24px;
        font-weight: 700;
        margin-bottom: 6px;
      }
      
      .overview-card-subtitle {
        font-size: 12px;
        color: var(--text-muted);
      }
      
      .network-illustration {
        position: absolute;
        bottom: 10px;
        right: 10px;
        width: 60px;
        height: 40px;
        opacity: 0.3;
      }
      
      /* Filter and View Controls */
      .controls-section {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 25px;
        padding: 0 10px;
      }
      
      .filter-buttons {
        display: flex;
        gap: 10px;
      }
      
      .filter-btn {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        border: 1px solid var(--border);
        background: var(--card-bg);
        cursor: pointer;
        transition: all 0.2s;
      }
      
      .filter-btn.active {
        border-color: var(--accent-blue);
      }
      
      .filter-btn.blue { border-color: var(--accent-blue); }
      .filter-btn.green { border-color: var(--accent-green); }
      .filter-btn.red { border-color: var(--accent-red); }
      
      .view-buttons {
        display: flex;
        gap: 8px;
      }
      
      .view-btn {
        width: 30px;
        height: 30px;
        border: 1px solid var(--border);
        background: var(--card-bg);
        border-radius: 6px;
        cursor: pointer;
        transition: all 0.2s;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      
      .view-btn svg {
        width: 14px;
        height: 14px;
        fill: var(--text-secondary);
      }
      
      .view-btn.active {
        border-color: var(--accent-blue);
      }
      
      .sort-button {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        background: var(--card-bg);
        border: 1px solid var(--border);
        border-radius: 6px;
        cursor: pointer;
        font-size: 12px;
        transition: all 0.2s;
      }
      
      .sort-button:hover {
        border-color: var(--accent-blue);
      }
      
      /* Server List */
      .server-list {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
        gap: 15px;
      }
      
      .loading {
        text-align: center;
        padding: 60px 20px;
        color: var(--text-muted);
        font-size: 14px;
        grid-column: 1 / -1;
      }
      
      .loading::before {
        content: '';
        display: inline-block;
        width: 20px;
        height: 20px;
        border: 2px solid var(--border);
        border-top: 2px solid var(--accent);
        border-radius: 50%;
        animation: spin 1s linear infinite;
        margin-right: 10px;
        vertical-align: middle;
      }
      
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      
      .server-card {
        background: var(--card-bg);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        padding: 15px;
        cursor: pointer;
        transition: all 0.2s;
      }
      
      .server-card:hover {
        border-color: var(--accent-blue);
        transform: translateY(-2px);
        box-shadow: var(--shadow);
      }
      
      .server-card-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 15px;
      }
      
      .server-info {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      
      .server-status {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      
      .server-status.online {
        background: var(--online);
        box-shadow: 0 0 0 3px rgba(0, 200, 81, 0.2);
      }
      
      .server-status.offline {
        background: var(--offline);
        box-shadow: 0 0 0 3px rgba(255, 68, 68, 0.2);
      }
      
      .server-name {
        font-size: 14px;
        font-weight: 600;
      }
      
      .server-metrics {
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: 12px;
        margin-bottom: 12px;
      }
      
      .metric {
        text-align: center;
      }
      
      .metric-label {
        font-size: 10px;
        color: var(--text-muted);
        margin-bottom: 3px;
        text-transform: uppercase;
      }
      
      .metric-value {
        font-size: 12px;
        font-weight: 600;
        margin-bottom: 3px;
      }
      
      .metric-percentage {
        font-size: 10px;
        padding: 1px 4px;
        border-radius: 3px;
        font-weight: 500;
      }
      
      .metric-percentage.low {
        background: rgba(40, 167, 69, 0.2);
        color: var(--accent-green);
      }
      
      .metric-percentage.medium {
        background: rgba(255, 193, 7, 0.2);
        color: #ffc107;
      }
      
      .metric-percentage.high {
        background: rgba(220, 53, 69, 0.2);
        color: var(--accent-red);
      }
      
      .network-speeds {
        display: flex;
        justify-content: space-between;
        font-size: 10px;
        color: var(--text-muted);
      }
      
      .speed {
        display: flex;
        align-items: center;
        gap: 3px;
      }
      
      .empty-state {
        text-align: center;
        padding: 40px 20px;
        color: var(--text-muted);
      }
      
      /* Footer */
      .footer {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-top: 40px;
        padding: 15px 8px;
        font-size: 11px;
        color: var(--text-muted);
        border-top: 1px solid var(--border);
      }
      
      /* Responsive */
      @media (max-width: 768px) {
        .container {
          padding: 15px;
        }
        
        .overview-cards {
          grid-template-columns: 1fr;
        }
        
        .server-list {
          grid-template-columns: 1fr;
        }
        
        .server-metrics {
          grid-template-columns: repeat(3, 1fr);
        }
        
        .controls-section {
          flex-direction: column;
          gap: 15px;
        }
      }
    </style>
  </head>
  <body>
    <div class="container">
      <!-- Header -->
      <header class="header">
        <div class="logo">
          <div class="logo-icon">N</div>
          <div class="logo-text">
            <span class="main">nezha</span>
            <span class="sub">哪吒監控</span>
          </div>
        </div>
        <div class="nav-icons">
          <div class="nav-icon" title="登錄">
            <svg viewBox="0 0 24 24">
              <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
            </svg>
          </div>
          <div class="nav-icon" title="搜索">
            <svg viewBox="0 0 24 24">
              <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
            </svg>
          </div>
          <div class="nav-icon" title="刷新">
            <svg viewBox="0 0 24 24">
              <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
            </svg>
          </div>
          <div class="online-indicator">
            <span class="online-dot"></span>
            <span id="onlineCount">1 在線</span>
          </div>
        </div>
      </header>

      <!-- Overview Section -->
      <section class="overview-section">
        <div class="overview-title">概覽</div>
        <div class="overview-time">目前時間 <span id="currentTime">--</span></div>
        
        <div class="overview-cards">
          <div class="overview-card">
            <div class="overview-card-header">
              <div class="overview-card-title">總伺服器</div>
              <div class="overview-card-icon icon-blue">
                <svg viewBox="0 0 24 24">
                  <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/>
                </svg>
              </div>
            </div>
            <div class="overview-card-value" id="totalServers">15</div>
            <div class="overview-card-subtitle">registered servers</div>
          </div>
          <div class="overview-card">
            <div class="overview-card-header">
              <div class="overview-card-title">線上伺服器</div>
              <div class="overview-card-icon icon-green">
                <svg viewBox="0 0 24 24">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                </svg>
              </div>
            </div>
            <div class="overview-card-value" id="onlineServers">5</div>
            <div class="overview-card-subtitle">currently reachable</div>
          </div>
          <div class="overview-card">
            <div class="overview-card-header">
              <div class="overview-card-title">離線伺服器</div>
              <div class="overview-card-icon icon-red">
                <svg viewBox="0 0 24 24">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
                </svg>
              </div>
            </div>
            <div class="overview-card-value" id="offlineServers">10</div>
            <div class="overview-card-subtitle">heartbeat timeout</div>
          </div>
          <div class="overview-card highlight">
            <div class="overview-card-header">
              <div class="overview-card-title">網路</div>
              <div class="overview-card-icon icon-purple">
                <svg viewBox="0 0 24 24">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.94-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
                </svg>
              </div>
            </div>
            <div class="overview-card-value" id="networkStats">↑5.83 TiB ↓4.74 TiB</div>
            <div class="overview-card-subtitle" id="networkSpeed">3.35 MiB/s 2.86 MiB/s</div>
            <div class="network-illustration">
              <svg viewBox="0 0 24 24" style="width: 16px; height: 16px; fill: var(--text-muted);">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
              </svg>
              <svg viewBox="0 0 24 24" style="width: 16px; height: 16px; fill: var(--text-muted);">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.94-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
              </svg>
            </div>
          </div>
        </div>
      </section>

      <!-- Controls Section -->
      <section class="controls-section">
        <div class="filter-buttons">
          <button class="filter-btn blue active" title="全部"></button>
          <button class="filter-btn green" title="線上"></button>
          <button class="filter-btn red" title="離線"></button>
        </div>
        
        <div class="view-buttons">
          <button class="view-btn active" title="列表視圖">
            <svg viewBox="0 0 24 24">
              <path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"/>
            </svg>
          </button>
          <button class="view-btn" title="網格視圖">
            <svg viewBox="0 0 24 24">
              <path d="M4 11h5V5H4v6zm0 7h5v-6H4v6zm6 0h5v-6h-5v6zm6-6v6h5v-6h-5zm-6-7h5V5h-5v6zm6-6v6h5V5h-5z"/>
            </svg>
          </button>
          <button class="view-btn" title="卡片視圖">
            <svg viewBox="0 0 24 24">
              <path d="M4 5h13v7H4zm14 0h2v5h-2zm-14 8h13v8H4zm14 0h2v5h-2z"/>
            </svg>
          </button>
        </div>
        
        <button class="sort-button" id="sortButton">
          Sort ↕
        </button>
      </section>

      <!-- Server List -->
      <main class="server-list" id="serverList">
        <!-- Server cards will be dynamically inserted here -->
      </main>

      <!-- Footer -->
      <footer class="footer">
        <div>©2020-2026 Nezha</div>
        <div>主題-nezha-dash (92fada4)</div>
      </footer>
    </div>

    <script>
      const state = {
        servers: [],
        sortMode: 'status',
        filterMode: 'all'
      };

      // Utility functions
      function esc(value) {
        return String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
      }

      function pct(value) {
        return value || value === 0 ? Number(value).toFixed(1) + "%" : "-";
      }

      function bytes(value) {
        const num = Number(value || 0);
        if (!Number.isFinite(num) || num <= 0) return "0 B";
        const units = ["B", "KB", "MB", "GB", "TB", "PB"];
        let idx = 0;
        let size = num;
        while (size >= 1024 && idx < units.length - 1) {
          size /= 1024;
          idx += 1;
        }
        return size.toFixed(size >= 10 || idx === 0 ? 0 : 1) + " " + units[idx];
      }

      function formatSpeed(value) {
        const num = Number(value || 0);
        if (!Number.isFinite(num) || num <= 0) return "0 B/s";
        const units = ["B/s", "K/s", "M/s", "G/s"];
        let idx = 0;
        let size = num;
        while (size >= 1024 && idx < units.length - 1) {
          size /= 1024;
          idx += 1;
        }
        return size.toFixed(size >= 10 || idx === 0 ? 0 : 1) + " " + units[idx];
      }

      function getPercentageClass(value) {
        const num = Number(value || 0);
        if (num < 50) return 'low';
        if (num < 80) return 'medium';
        return 'high';
      }

      // Server card rendering
      function renderServerCard(server) {
        const statusClass = server.online ? 'online' : 'offline';
        const cpuClass = getPercentageClass(server.cpu_usage);
        const memClass = getPercentageClass(server.mem_usage_pct);
        const diskClass = getPercentageClass(server.disk_usage_pct);
        
        return \`
          <div class="server-card" data-server-link="/servers/\${esc(server.id)}">
            <div class="server-card-header">
              <div class="server-info">
                <div class="server-status \${statusClass}"></div>
                <div class="server-name">\${esc(server.name || 'Unnamed')}</div>
              </div>
            </div>
            
            <div class="server-metrics">
              <div class="metric">
                <div class="metric-label">CPU</div>
                <div class="metric-value">\${pct(server.cpu_usage)}</div>
                <div class="metric-percentage \${cpuClass}">\${pct(server.cpu_usage)}</div>
              </div>
              <div class="metric">
                <div class="metric-label">內存</div>
                <div class="metric-value">\${bytes(server.mem_used)}</div>
                <div class="metric-percentage \${memClass}">\${pct(server.mem_usage_pct)}</div>
              </div>
              <div class="metric">
                <div class="metric-label">存儲</div>
                <div class="metric-value">\${bytes(server.disk_used)}</div>
                <div class="metric-percentage \${diskClass}">\${pct(server.disk_usage_pct)}</div>
              </div>
              <div class="metric">
                <div class="metric-label">上傳</div>
                <div class="metric-value">\${formatSpeed(server.net_out_speed)}</div>
                <div class="metric-percentage low">↑</div>
              </div>
              <div class="metric">
                <div class="metric-label">下載</div>
                <div class="metric-value">\${formatSpeed(server.net_in_speed)}</div>
                <div class="metric-percentage low">↓</div>
              </div>
            </div>
            
            <div class="network-speeds">
              <div class="speed">↑ \${formatSpeed(server.net_out_speed)}</div>
              <div class="speed">↓ \${formatSpeed(server.net_in_speed)}</div>
            </div>
          </div>
        \`;
      }

      // WebSocket connection
      let ws = null;
      let reconnectTimer = null;
      let pollTimer = null;
      let hasReceivedInitialData = false;
      
      function connectWebSocket() {
        try {
          const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
          const wsUrl = protocol + '//' + window.location.host + '/ws/client';
          
          ws = new WebSocket(wsUrl);
          
          ws.onopen = () => {
            console.log('WebSocket connected');
            if (reconnectTimer) {
              clearTimeout(reconnectTimer);
              reconnectTimer = null;
            }
            
            // 更新连接状态
            const serverList = document.getElementById('serverList');
            if (serverList) {
              serverList.innerHTML = '<div class="loading">正在接收数据...</div>';
            }
          };
          
          ws.onmessage = (event) => {
            console.log('WebSocket message received:', event.data);
            console.log('WebSocket message received (raw):', event);
            try {
              const message = JSON.parse(event.data);
              console.log('Parsed WebSocket message:', message);
              console.log('Parsed WebSocket message (raw):', message);
              handleWebSocketMessage(message);
            } catch (error) {
              console.error('Failed to parse WebSocket message:', error);
            }
          };
          
          ws.onclose = () => {
            console.log('WebSocket disconnected, attempting to reconnect...');
            
            // 显示重连状态
            const serverList = document.getElementById('serverList');
            if (serverList) {
              serverList.innerHTML = '<div class="loading">连接断开，正在重连...</div>';
            }
            
            scheduleReconnect();
          };
          
          ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            
            // 显示错误状态
            const serverList = document.getElementById('serverList');
            if (serverList) {
              serverList.innerHTML = '<div class="loading">连接错误，正在重连...</div>';
            }
          };
        } catch (error) {
          console.error('Failed to connect WebSocket:', error);
          
          // 显示连接失败状态
          const serverList = document.getElementById('serverList');
          if (serverList) {
            serverList.innerHTML = '<div class="loading">连接失败，正在重连...</div>';
          }
          
          scheduleReconnect();
        }
      }
      
      function scheduleReconnect() {
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            connectWebSocket();
          }, 5000); // 5秒后重连
        }
      }
      
      // 轮询函数已移除，现在完全依赖WebSocket定期推送
      
      function handleWebSocketMessage(message) {
        console.log('Handling WebSocket message:', message.type);
        switch (message.type) {
          case 'dashboard_update':
            if (message.data && message.data.ok) {
              // 从groups和servers中提取服务器数据
              const groupServers = message.data.groups?.flatMap(g => g.servers || []) || [];
              const directServers = message.data.servers || [];
              state.servers = [...groupServers, ...directServers];
              console.log('Updated servers state:', state.servers);
              console.log('First server data:', state.servers[0]); // 调试第一个服务器
              render();
              
              // 标记已接收数据，但不启动轮询（因为后端会定期推送）
              if (!hasReceivedInitialData) {
                hasReceivedInitialData = true;
                console.log('Received initial data, backend will push updates every 30s');
              }
            }
            break;
          case 'agent_update':
            // 单个agent更新，更新对应服务器数据
            if (message.data && message.node_id) {
              updateServerData(message.node_id, message.data);
              console.log('Updated server data for:', message.node_id, message.data);
            }
            break;
          case 'metrics_update':
            // 实时指标更新
            if (message.data && message.node_id) {
              updateServerMetrics(message.node_id, message.data);
            }
            break;
          case 'agent_disconnect':
            // agent离线
            if (message.node_id) {
              markServerOffline(message.node_id);
            }
            break;
          case 'error':
            console.error('Server error:', message.message);
            break;
          default:
            console.log('Unknown message type:', message.type);
        }
      }
      
      function updateServerData(nodeId, heartbeatData) {
        const server = state.servers.find(s => s.id === nodeId);
        if (server) {
          // 更新服务器状态
          Object.assign(server, {
            online: true,
            status: heartbeatData.status || 'online',
            cpu_usage: heartbeatData.metrics?.cpu_usage,
            memory_total: heartbeatData.metrics?.memory_total,
            memory_used: heartbeatData.metrics?.memory_used,
            disk_total: heartbeatData.metrics?.disk_total,
            disk_used: heartbeatData.metrics?.disk_used,
            net_in_transfer: heartbeatData.metrics?.net_in_transfer,
            net_out_transfer: heartbeatData.metrics?.net_out_transfer,
            net_in_speed: heartbeatData.metrics?.net_in_speed,
            net_out_speed: heartbeatData.metrics?.net_out_speed,
            uptime: heartbeatData.metrics?.uptime,
            load_1: heartbeatData.metrics?.load_1,
            load_5: heartbeatData.metrics?.load_5,
            load_15: heartbeatData.metrics?.load_15,
            last_seen: heartbeatData.timestamp
          });
          render();
        }
      }
      
      function updateServerMetrics(nodeId, metrics) {
        const server = state.servers.find(s => s.id === nodeId);
        if (server) {
          // 只更新指标数据
          Object.assign(server, metrics);
          render();
        }
      }
      
      function markServerOffline(nodeId) {
        const server = state.servers.find(s => s.id === nodeId);
        if (server) {
          server.online = false;
          server.status = 'offline';
          render();
        }
      }

      // Data loading and rendering - 只通过WebSocket

      function render() {
        const servers = filterAndSortServers(state.servers);
        const total = servers.length;
        const online = servers.filter(s => s.online).length;
        const offline = total - online;
        
        // Update overview cards
        document.getElementById('totalServers').textContent = total;
        document.getElementById('onlineServers').textContent = online;
        document.getElementById('offlineServers').textContent = offline;
        document.getElementById('onlineCount').textContent = \`\${online} 在線\`;
        
        // Calculate network stats
        const totalUpload = servers.reduce((sum, s) => sum + (s.net_out_transfer || 0), 0);
        const totalDownload = servers.reduce((sum, s) => sum + (s.net_in_transfer || 0), 0);
        const currentUploadSpeed = servers.reduce((sum, s) => sum + (s.net_out_speed || 0), 0);
        const currentDownloadSpeed = servers.reduce((sum, s) => sum + (s.net_in_speed || 0), 0);
        
        document.getElementById('networkStats').textContent = \`↑\${bytes(totalUpload)} ↓\${bytes(totalDownload)}\`;
        document.getElementById('networkSpeed').textContent = \`\${formatSpeed(currentUploadSpeed)} \${formatSpeed(currentDownloadSpeed)}\`;
        
        // Update time
        document.getElementById('currentTime').textContent = new Date().toLocaleTimeString();
        
        // Render server list
        const serverListEl = document.getElementById('serverList');
        if (servers.length > 0) {
          serverListEl.innerHTML = servers.map(renderServerCard).join('');
        } else {
          serverListEl.innerHTML = '<div class="empty-state">暂无服务器数据</div>';
        }
      }

      function filterAndSortServers(servers) {
        let filtered = servers;
        
        // Apply filter
        if (state.filterMode === 'online') {
          filtered = servers.filter(s => s.online);
        } else if (state.filterMode === 'offline') {
          filtered = servers.filter(s => !s.online);
        }
        
        // Apply sort
        filtered.sort((a, b) => {
          if (state.sortMode === 'status') {
            return (b.online ? 1 : 0) - (a.online ? 1 : 0);
          } else if (state.sortMode === 'cpu') {
            return (b.cpu_usage || 0) - (a.cpu_usage || 0);
          } else if (state.sortMode === 'name') {
            return (a.name || '').localeCompare(b.name || '');
          }
          return 0;
        });
        
        return filtered;
      }

      // Event listeners
      document.addEventListener('DOMContentLoaded', () => {
        // 只使用WebSocket连接
        console.log('Page loaded, connecting to WebSocket...');
        connectWebSocket();
        
        // 显示加载状态
        const serverList = document.getElementById('serverList');
        if (serverList) {
          serverList.innerHTML = '<div class="loading">正在连接WebSocket...</div>';
        }
        
        // Update time every second
        setInterval(() => {
          document.getElementById('currentTime').textContent = new Date().toLocaleTimeString();
        }, 1000);
        
        // Server card navigation
        document.body.addEventListener('click', (e) => {
          const card = e.target.closest('[data-server-link]');
          if (card) {
            window.location.href = card.dataset.serverLink;
          }
        });
        
        // Filter buttons
        document.querySelectorAll('.filter-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            if (btn.classList.contains('blue')) state.filterMode = 'all';
            else if (btn.classList.contains('green')) state.filterMode = 'online';
            else if (btn.classList.contains('red')) state.filterMode = 'offline';
            
            render();
          });
        });
        
        // Sort button
        document.getElementById('sortButton').addEventListener('click', () => {
          const modes = ['status', 'cpu', 'name'];
          const currentIndex = modes.indexOf(state.sortMode);
          state.sortMode = modes[(currentIndex + 1) % modes.length];
          render();
        });
      });
    </script>
  </body>
</html>`;
}

function splitTags(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function json(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function sseStream() {
  let timer = null;
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (data) => {
        controller.enqueue(
          encoder.encode("data: " + JSON.stringify(data) + "\n\n")
        );
      };

      send({ ok: true, ts: Date.now() });
      timer = setInterval(() => {
        send({ ts: Date.now() });
      }, 12000);
    },
    cancel() {
      if (timer) {
        clearInterval(timer);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

async function handleAgentWebSocket(request, env) {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();

  const url = new URL(request.url);
  const nodeId = url.searchParams.get('node_id');
  const token = url.searchParams.get('token');
  
  if (!nodeId || !token) {
    return new Response('Missing node_id or token parameter', { status: 400 });
  }

  console.log(`Agent ${nodeId} connected via WebSocket (token: ${token})`);

  // 添加到全局管理器
  wsManager.addClient(server, 'agent');
  const wsConfig = await getWebSocketSettings(env);
  
  // 检查WebSocket是否启用
  if (!wsConfig.enabled) {
    return new Response('WebSocket connections are disabled', { status: 403 });
  }

  // 验证agent身份
  try {
    await verifyAgentRequest(request, env, nodeId);
  } catch (error) {
    return new Response('Unauthorized', { status: 401 });
  }

  // 检查连接数限制
  if (!env.agentConnections) {
    env.agentConnections = new Map();
  }
  
  // Agent消息处理
  server.addEventListener('message', async (event) => {
    try {
      const data = JSON.parse(event.data);
      console.log(`[${new Date().toISOString()}] Received message from agent ${nodeId}:`, data.type);

      switch (data.type) {
        case 'heartbeat':
          console.log(`[${new Date().toISOString()}] Agent ${nodeId} heartbeat received - storing in memory`);
          
          // 存储Agent数据到内存中，避免跨请求I/O
          wsManager.storeAgentData(nodeId, data.payload);

          // 更新last_seen
          try {
            await env.DB.prepare(
              "UPDATE nodes SET last_seen = ?1 WHERE id = ?2"
            ).bind(nowUnix(), nodeId).run();
          } catch (error) {
            console.error('Failed to update last_seen:', error);
          }

          // 发送确认
          server.send(JSON.stringify({ 
            type: 'heartbeat_ack', 
            timestamp: nowUnix() 
          }));
          break;

        case 'metrics':
          console.log(`[${new Date().toISOString()}] Agent ${nodeId} metrics received - storing in memory`);
          
          // 存储指标数据到内存
          wsManager.storeAgentData(nodeId, data.payload);
          break;

        case 'ping':
          console.log(`[${new Date().toISOString()}] Agent ${nodeId} ping received`);
          server.send(JSON.stringify({ 
            type: 'pong', 
            timestamp: nowUnix() 
          }));
          break;

        default:
          console.log(`[${new Date().toISOString()}] Unknown message type from agent ${nodeId}:`, data.type);
      }
    } catch (error) {
      console.error(`Failed to parse message from agent ${nodeId}:`, error);
    }
  });

  // 关闭处理
  server.addEventListener('close', () => {
    wsManager.remove(server);
    console.log(`Agent ${nodeId} disconnected`);
    // 注意：由于跨请求I/O限制，不能直接广播消息
    // 前端会通过定时检查来发现Agent离线状态
  });

  return new Response(null, { status: 101, webSocket: client });
}

async function handleClientWebSocket(request, env) {
  // 创建WebSocket连接
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();

  // 添加到全局管理器
  wsManager.addClient(server, 'client');

  // 设置定期检查Agent数据的定时器
  const statusInterval = setInterval(async () => {
    try {
      const auth = {
        authenticated: false,
        mode: "public",
        role: "viewer",
        username: "guest",
        permissions: expandPermissions("viewer", "read"),
      };
      const data = await buildDashboardPayload(env, auth);
      
      // 更新服务器状态：如果有Agent最近有连接（通过心跳时间判断），标记为在线
      if (data.groups) {
        for (const group of data.groups) {
          for (const server of group.servers || []) {
            if (server.last_seen && (nowUnix() - server.last_seen) < 60) {
              server.online = true;
              server.status = 'online';
            } else {
              server.online = false;
              server.status = 'offline';
            }
            
            // 尝试从内存获取实时数据
            const agentData = wsManager.getAgentData(server.id);
            if (agentData && (Date.now() - agentData.lastUpdate) < 10000) { // 10秒内的数据
              console.log(`Using cached agent data for ${server.id}`);
              // 用内存中的数据覆盖服务器信息
              server.cpu_usage = agentData.cpu_usage || 0;
              server.mem_total = agentData.mem_total || 0;
              server.mem_used = agentData.mem_used || 0;
              server.mem_usage_pct = agentData.mem_total ? 
                ((agentData.mem_used / agentData.mem_total) * 100).toFixed(2) + '%' : 'N/A';
              server.net_in_speed = agentData.net_in_speed || 0;
              server.net_out_speed = agentData.net_out_speed || 0;
              server.net_in_transfer = agentData.net_in_transfer || 0;
              server.net_out_transfer = agentData.net_out_transfer || 0;
              server.disk_total = agentData.disk_total || 0;
              server.disk_used = agentData.disk_used || 0;
              server.disk_usage_pct = agentData.disk_total ? 
                ((agentData.disk_used / agentData.disk_total) * 100).toFixed(2) + '%' : 'N/A';
              server.load_1 = agentData.load_1 || 0;
              server.process_count = agentData.process_count || 0;
              server.tcp_conn_count = agentData.tcp_conn_count || 0;
              server.udp_conn_count = agentData.udp_conn_count || 0;
            }
          }
        }
      }
      
      const statusMessage = JSON.stringify({
        type: 'dashboard_update',
        data: {
          ok: true,
          generated_at: nowUnix(),
          timeout_sec: getHeartbeatTimeoutSec(env),
          ...data,
        }
      });
      
      server.send(statusMessage);
      console.log('Sent periodic status update to frontend');
    } catch (error) {
      console.error('Failed to send periodic status update:', error);
    }
  }, 5000); // 每5秒检查一次

  // 发送初始数据 - 使用公共访问权限
  try {
    const auth = {
      authenticated: false,
      mode: "public",
      role: "viewer",
      username: "guest",
      permissions: expandPermissions("viewer", "read"),
    };
    const data = await buildDashboardPayload(env, auth);
    
    // 初始状态更新：根据last_seen判断在线状态
    if (data.groups) {
      for (const group of data.groups) {
        for (const server of group.servers || []) {
          if (server.last_seen && (nowUnix() - server.last_seen) < 60) {
            server.online = true;
            server.status = 'online';
          } else {
            server.online = false;
            server.status = 'offline';
          }
        }
      }
    }
    
    const initialMessage = JSON.stringify({
      type: 'dashboard_update',
      data: {
        ok: true,
        generated_at: nowUnix(),
        timeout_sec: getHeartbeatTimeoutSec(env),
        ...data,
      }
    });
    console.log('Sending initial data to client:', initialMessage.substring(0, 100) + '...');
    server.send(initialMessage);
  } catch (error) {
    console.error('Failed to send initial data:', error);
    server.send(JSON.stringify({
      type: 'error',
      message: 'Failed to load initial data'
    }));
  }

  // 简单的消息处理
  server.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'ping') {
        server.send(JSON.stringify({
          type: 'pong',
          timestamp: nowUnix()
        }));
      }
    } catch (error) {
      // 忽略解析错误
    }
  });

  // 关闭处理
  server.addEventListener('close', () => {
    clearInterval(statusInterval); // 清理定时器
    wsManager.remove(server);
  });

  // 错误处理
  server.addEventListener('error', (error) => {
    clearInterval(statusInterval); // 清理定时器
    console.error('WebSocket error for client:', error);
    wsManager.remove(server);
  });

  return new Response(null, { status: 101, webSocket: client });
}

// 广播消息到前端WebSocket连接
async function broadcastToFrontend(env, message) {
  if (!env.clientConnections) {
    env.clientConnections = new Set();
  }
  
  const messageStr = JSON.stringify(message);
  const deadConnections = new Set();
  
  for (const connection of env.clientConnections) {
    try {
      connection.send(messageStr);
    } catch (error) {
      console.error('Failed to send to client:', error);
      deadConnections.add(connection);
    }
  }
  
  // 清理死连接
  for (const dead of deadConnections) {
    env.clientConnections.delete(dead);
  }
  
  console.log('Broadcasted to', env.clientConnections.size, 'clients:', message.type);
}

// 处理实时指标数据
async function processRealTimeMetrics(env, nodeId, metrics) {
  // 存储到数据库或缓存
  console.log(`Processing real-time metrics for ${nodeId}:`, metrics);
}

async function parseJson(request) {
  try {
    return await request.json();
  } catch {
    throw new Error("request body must be valid JSON");
  }
}

function trimTrailingSlash(path) {
  return path.replace(/\/+$/, "");
}

function joinTags(value) {
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((item) => String(item).trim())
    .filter(Boolean)
    .join(",");
}

function percentage(used, total) {
  const a = Number(used || 0);
  const b = Number(total || 0);
  return a > 0 && b > 0 ? (a / b) * 100 : 0;
}

function detectRecordType(content) {
  return String(content).includes(":") ? "AAAA" : "A";
}

function getHeartbeatTimeoutSec(env) {
  return Number(env.DEFAULT_HEARTBEAT_TIMEOUT_SEC || "180");
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function renderAuthHtml() {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>管理后台 - 登录</title>
    <style>
      :root {
        --bg: #0b0807;
        --card-bg: rgba(18, 12, 10, 0.96);
        --border: rgba(255,244,232,.08);
        --text-primary: #f8f1e7;
        --text-secondary: #cccccc;
        --accent: #d2a96b;
        --radius: 12px;
      }
      
      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }
      
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        background: var(--bg);
        color: var(--text-primary);
        line-height: 1.6;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      
      .container {
        max-width: 400px;
        width: 100%;
        padding: 20px;
      }
      
      .card {
        background: var(--card-bg);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        padding: 32px;
      }
      
      .header {
        text-align: center;
        margin-bottom: 32px;
      }
      
      .header h1 {
        font-size: 1.8rem;
        font-weight: 700;
        margin-bottom: 8px;
      }
      
      .header p {
        color: var(--text-secondary);
        font-size: 1rem;
      }
      
      .form-group {
        margin-bottom: 20px;
      }
      
      .form-group label {
        display: block;
        margin-bottom: 8px;
        font-weight: 600;
        color: var(--text-secondary);
      }
      
      .form-group input {
        width: 100%;
        padding: 12px;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--bg);
        color: var(--text-primary);
        font-size: 1rem;
      }
      
      .form-group input:focus {
        outline: none;
        border-color: var(--accent);
      }
      
      .btn {
        width: 100%;
        background: var(--accent);
        color: white;
        border: none;
        padding: 12px 24px;
        border-radius: 8px;
        font-size: 1rem;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.2s ease;
      }
      
      .btn:hover {
        background: #b8934f;
      }
      
      .help-text {
        font-size: 0.9rem;
        color: var(--text-secondary);
        margin-top: 20px;
        text-align: center;
        line-height: 1.5;
      }
      
      .alert {
        background: rgba(220, 53, 69, 0.1);
        border: 1px solid rgba(220, 53, 69, 0.3);
        color: var(--danger);
        padding: 12px;
        border-radius: 8px;
        margin-bottom: 20px;
        display: none;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="card">
        <div class="header">
          <h1>🔐 管理后台</h1>
          <p>请输入管理员认证令牌</p>
        </div>
        
        <div id="auth-alert" class="alert"></div>
        
        <form onsubmit="handleLogin(event)">
          <div class="form-group">
            <label for="token">认证令牌</label>
            <input type="password" id="token" placeholder="请输入ADMIN_SHARED_SECRET" required>
          </div>
          
          <button type="submit" class="btn">登录</button>
        </form>
        
        <div class="help-text">
          <strong>默认令牌：</strong> change-me-too<br>
          <strong>配置文件：</strong> wrangler.toml → [vars] → ADMIN_SHARED_SECRET
        </div>
      </div>
    </div>

    <script>
      function handleLogin(event) {
        event.preventDefault();
        
        const token = document.getElementById('token').value;
        if (!token) {
          showAlert('请输入认证令牌', 'danger');
          return;
        }
        
        // 保存token到localStorage
        localStorage.setItem('admin_token', token);
        
        // 使用查询参数重新加载管理页面
        window.location.href = '/admin?token=' + encodeURIComponent(token);
      }
      
      function showAlert(message, type = 'info') {
        const alertDiv = document.getElementById('auth-alert');
        alertDiv.textContent = message;
        alertDiv.style.display = 'block';
        
        setTimeout(() => {
          alertDiv.style.display = 'none';
        }, 5000);
      }
      
      // 页面加载时检查URL参数中的错误信息
      const urlParams = new URLSearchParams(window.location.search);
      const error = urlParams.get('error');
      if (error) {
        showAlert(decodeURIComponent(error), 'danger');
      }
    </script>
  </body>
</html>`;
}

function renderAdminHtml(env) {
  const title = escapeHtml(env.DASHBOARD_TITLE || "Server Status");
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title} - 管理后台</title>
    <style>
      :root {
        --bg: #0b0807;
        --card-bg: rgba(18, 12, 10, 0.96);
        --border: rgba(255,244,232,.08);
        --text-primary: #f8f1e7;
        --text-secondary: #cccccc;
        --text-muted: #888888;
        --accent: #d2a96b;
        --accent-soft: rgba(210,169,107,.14);
        --success: #28a745;
        --danger: #dc3545;
        --radius: 12px;
      }
      
      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }
      
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        background: var(--bg);
        color: var(--text-primary);
        line-height: 1.6;
        min-height: 100vh;
      }
      
      .container {
        max-width: 800px;
        margin: 0 auto;
        padding: 40px 20px;
      }
      
      .header {
        text-align: center;
        margin-bottom: 40px;
      }
      
      .header h1 {
        font-size: 2.5rem;
        font-weight: 700;
        margin-bottom: 10px;
      }
      
      .header p {
        color: var(--text-muted);
        font-size: 1.1rem;
      }
      
      .nav-tabs {
        display: flex;
        border-bottom: 2px solid var(--border);
        margin-bottom: 30px;
      }
      
      .nav-tab {
        padding: 12px 24px;
        background: none;
        border: none;
        color: var(--text-secondary);
        cursor: pointer;
        font-size: 1rem;
        border-bottom: 3px solid transparent;
        transition: all 0.2s ease;
      }
      
      .nav-tab.active {
        color: var(--accent);
        border-bottom-color: var(--accent);
      }
      
      .nav-tab:hover {
        color: var(--text-primary);
      }
      
      .section {
        display: none;
      }
      
      .section.active {
        display: block;
      }
      
      .card {
        background: var(--card-bg);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        padding: 24px;
        margin-bottom: 20px;
      }
      
      .card h2 {
        font-size: 1.5rem;
        margin-bottom: 20px;
        color: var(--text-primary);
      }
      
      .form-group {
        margin-bottom: 20px;
      }
      
      .form-group label {
        display: block;
        margin-bottom: 8px;
        font-weight: 600;
        color: var(--text-secondary);
      }
      
      .form-group input,
      .form-group select {
        width: 100%;
        padding: 12px;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--bg);
        color: var(--text-primary);
        font-size: 1rem;
      }
      
      .form-group input:focus,
      .form-group select:focus {
        outline: none;
        border-color: var(--accent);
      }
      
      .form-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 20px;
      }
      
      .switch {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      
      .switch input[type="checkbox"] {
        width: 20px;
        height: 20px;
      }
      
      .btn {
        background: var(--accent);
        color: white;
        border: none;
        padding: 12px 24px;
        border-radius: 8px;
        font-size: 1rem;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.2s ease;
      }
      
      .btn:hover {
        background: #b8934f;
      }
      
      .btn-danger {
        background: var(--danger);
      }
      
      .btn-danger:hover {
        background: #c82333;
      }
      
      .status {
        display: inline-block;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 0.8rem;
        font-weight: 600;
      }
      
      .status.enabled {
        background: var(--success);
        color: white;
      }
      
      .status.disabled {
        background: var(--danger);
        color: white;
      }
      
      .help-text {
        font-size: 0.9rem;
        color: var(--text-muted);
        margin-top: 10px;
        line-height: 1.5;
      }
      
      .alert {
        background: rgba(40, 167, 69, 0.1);
        border: 1px solid rgba(40, 167, 69, 0.3);
        color: var(--success);
        padding: 12px;
        border-radius: 8px;
        margin-bottom: 20px;
      }
      
      .alert.danger {
        background: rgba(220, 53, 69, 0.1);
        border-color: rgba(220, 53, 69, 0.3);
        color: var(--danger);
      }
      
      .loading {
        text-align: center;
        color: var(--text-secondary);
        padding: 20px;
      }
      
      .server-list {
        display: grid;
        gap: 16px;
      }
      
      .server-item {
        background: var(--card-bg);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        padding: 20px;
        transition: all 0.2s ease;
      }
      
      .server-item:hover {
        border-color: var(--accent);
      }
      
      .server-item.expanded {
        border-color: var(--accent);
        box-shadow: 0 0 0 2px rgba(210, 169, 107, 0.2);
      }
      
      .server-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 16px;
      }
      
      .server-info {
        flex: 1;
      }
      
      .server-name {
        font-size: 1.2rem;
        font-weight: 600;
        color: var(--text-primary);
        margin-bottom: 4px;
      }
      
      .server-id {
        font-size: 0.9rem;
        color: var(--text-secondary);
      }
      
      .server-status {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      
      .status-indicator {
        width: 8px;
        height: 8px;
        border-radius: 50%;
      }
      
      .status-indicator.online {
        background: var(--success);
      }
      
      .status-indicator.offline {
        background: var(--danger);
      }
      
      .server-actions {
        display: flex;
        gap: 8px;
      }
      
      .btn-small {
        padding: 6px 12px;
        font-size: 0.9rem;
        border-radius: 6px;
      }
      
      .server-details {
        display: none;
        margin-top: 16px;
        padding-top: 16px;
        border-top: 1px solid var(--border);
      }
      
      .server-details.show {
        display: block;
      }
      
      .server-form {
        display: grid;
        gap: 16px;
      }
      
      .server-form .form-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 16px;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h1>
          <svg viewBox="0 0 24 24" style="width: 32px; height: 32px; fill: var(--accent); vertical-align: middle; margin-right: 10px;">
            <path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"/>
          </svg>
          管理后台
        </h1>
        <p>配置服务器监控系统的WebSocket连接和设置</p>
      </div>
      
      <div class="nav-tabs">
        <button class="nav-tab active" data-tab="websocket" onclick="switchTab('websocket')">WebSocket设置</button>
        <button class="nav-tab" data-tab="servers" onclick="switchTab('servers')">服务器管理</button>
        <button class="nav-tab" data-tab="agents" onclick="switchTab('agents')">Agent连接</button>
      </div>
      
      <!-- WebSocket设置 -->
      <div id="websocket-section" class="section active">
        <div class="card">
          <h2>
            <svg viewBox="0 0 24 24" style="width: 20px; height: 20px; fill: var(--accent); vertical-align: middle; margin-right: 8px;">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.94-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
            </svg>
            WebSocket配置
          </h2>
          
          <div id="ws-alert"></div>
          
          <div class="form-group">
            <label>启用WebSocket连接</label>
            <div class="switch">
              <input type="checkbox" id="ws-enabled">
              <span>启用Agent通过WebSocket连接</span>
            </div>
          </div>
          
          <div class="form-group">
            <label>最大连接数</label>
            <input type="number" id="ws-max-connections" min="1" max="1000" placeholder="100">
          </div>
          
          <div class="form-row">
            <div class="form-group">
              <label>心跳间隔 (秒)</label>
              <input type="number" id="ws-heartbeat-interval" min="5" max="300" placeholder="30">
            </div>
            <div class="form-group">
              <label>Ping间隔 (秒)</label>
              <input type="number" id="ws-ping-interval" min="5" max="300" placeholder="30">
            </div>
          </div>
          
          <div class="form-row">
            <div class="form-group">
              <label>重连间隔 (秒)</label>
              <input type="number" id="ws-reconnect-interval" min="5" max="300" placeholder="10">
            </div>
            <div class="form-group">
              <label>连接超时 (秒)</label>
              <input type="number" id="ws-connection-timeout" min="10" max="600" placeholder="60">
            </div>
          </div>
          
          <button class="btn" onclick="saveWebSocketSettings()">保存设置</button>
          
          <div class="help-text">
            <strong>配置说明：</strong><br>
            • 启用WebSocket后，Agent将通过WebSocket实时连接到服务器<br>
            • 最大连接数限制同时连接的Agent数量<br>
            • 心跳间隔设置Agent发送心跳的频率<br>
            • Ping间隔用于检测连接状态<br>
            • 连接超时设置无响应自动断开的时间
          </div>
        </div>
      </div>
      
      <!-- 服务器管理 -->
      <div id="servers-section" class="section">
        <div class="card">
          <h2>
            <svg viewBox="0 0 24 24" style="width: 20px; height: 20px; fill: var(--accent); vertical-align: middle; margin-right: 8px;">
              <path d="M12 2l-5.5 9h11L12 2zm0 18l5.5-9h-11L12 20zm0-18l-5.5 9h11L12 2z"/>
            </svg>
            服务器管理
          </h2>
          
          <div id="server-alert"></div>
          
          <!-- 服务器列表 -->
          <div id="servers-list">
            <div class="loading">加载中...</div>
          </div>
          
          <div class="help-text">
            <strong>管理说明：</strong><br>
            • 点击服务器卡片展开编辑选项<br>
            • 修改服务器名称、分组、位置等信息<br>
            • DDNS启用后会自动更新域名解析<br>
            • 删除服务器操作不可恢复，请谨慎操作
          </div>
        </div>
      </div>
      
      <!-- Agent连接状态 -->
      <div id="agents-section" class="section">
        <div class="card">
          <h2>
            <svg viewBox="0 0 24 24" style="width: 20px; height: 20px; fill: var(--accent); vertical-align: middle; margin-right: 8px;">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
            </svg>
            Agent连接状态
          </h2>
          <div id="agents-list"></div>
        </div>
      </div>
    </div>

    <script>
      // 标签切换函数 - 必须在HTML使用之前定义
      function switchTab(tabName) {
        console.log('Switching to tab:', tabName);
        
        // 移除所有active类
        document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
        
        // 添加active类到当前标签和内容
        const currentTab = document.querySelector('[data-tab="' + tabName + '"]');
        if (currentTab) {
          currentTab.classList.add('active');
        }
        
        const currentSection = document.getElementById(tabName + '-section');
        if (currentSection) {
          currentSection.classList.add('active');
        }
        
        // 加载数据
        if (tabName === 'agents') {
          loadAgentStatus();
        } else if (tabName === 'servers') {
          loadServers();
        }
      }
      
      let currentSettings = {};
      
      // 自动添加认证token到所有API请求
      function addAuthHeader(options = {}) {
        const token = localStorage.getItem('admin_token');
        if (token) {
          options.headers = Object.assign({}, options.headers || {}, {
            'Authorization': 'Bearer ' + token
          });
        }
        return options;
      }
      
      // 加载WebSocket设置
      async function loadWebSocketSettings() {
        try {
          const response = await fetch('/api/admin/settings/websocket', addAuthHeader());
          const data = await response.json();
          
          if (data.ok) {
            currentSettings = data.settings;
            document.getElementById('ws-enabled').checked = data.settings.enabled;
            document.getElementById('ws-max-connections').value = data.settings.max_connections;
            document.getElementById('ws-heartbeat-interval').value = data.settings.heartbeat_interval;
            document.getElementById('ws-ping-interval').value = data.settings.ping_interval;
            document.getElementById('ws-reconnect-interval').value = data.settings.reconnect_interval;
            document.getElementById('ws-connection-timeout').value = data.settings.connection_timeout;
            
            showAlert('WebSocket设置已加载', 'success');
          } else {
            showAlert('加载设置失败: ' + data.error, 'danger');
          }
        } catch (error) {
          showAlert('加载设置时发生错误: ' + error.message, 'danger');
        }
      }
      
      // 保存WebSocket设置
      async function saveWebSocketSettings() {
        const settings = {
          enabled: document.getElementById('ws-enabled').checked,
          max_connections: parseInt(document.getElementById('ws-max-connections').value) || 100,
          heartbeat_interval: parseInt(document.getElementById('ws-heartbeat-interval').value) || 30,
          ping_interval: parseInt(document.getElementById('ws-ping-interval').value) || 30,
          reconnect_interval: parseInt(document.getElementById('ws-reconnect-interval').value) || 10,
          connection_timeout: parseInt(document.getElementById('ws-connection-timeout').value) || 60
        };
        
        try {
          const response = await fetch('/api/admin/settings/websocket', addAuthHeader({
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(settings)
          }));
          
          const data = await response.json();
          
          if (data.ok) {
            currentSettings = settings;
            showAlert('WebSocket设置已保存', 'success');
          } else {
            showAlert('保存设置失败: ' + data.error, 'danger');
          }
        } catch (error) {
          showAlert('保存设置时发生错误: ' + error.message, 'danger');
        }
      }
      
      // 加载Agent连接状态
      async function loadAgentStatus() {
        try {
          const response = await fetch('/api/admin/settings/websocket');
          const data = await response.json();
          
          if (data.ok) {
            // 这里可以扩展为实际的Agent连接列表
            const agentsList = document.getElementById('agents-list');
            agentsList.innerHTML = 
              '<div class="help-text">' +
                '<strong>当前WebSocket状态：</strong>' +
                '<span class="status ' + (data.settings.enabled ? 'enabled' : 'disabled') + '">' +
                  (data.settings.enabled ? '已启用' : '已禁用') +
                '</span>' +
              '</div>' +
              '<div class="help-text">' +
                '<strong>配置参数：</strong><br>' +
                '• 最大连接数: ' + data.settings.max_connections + '<br>' +
                '• 心跳间隔: ' + data.settings.heartbeat_interval + '秒<br>' +
                '• Ping间隔: ' + data.settings.ping_interval + '秒<br>' +
                '• 重连间隔: ' + data.settings.reconnect_interval + '秒<br>' +
                '• 连接超时: ' + data.settings.connection_timeout + '秒' +
              '</div>';
          } else {
            document.getElementById('agents-list').innerHTML = 
              '<div class="alert danger">加载Agent状态失败: ' + data.error + '</div>';
          }
        } catch (error) {
          document.getElementById('agents-list').innerHTML = 
            '<div class="alert danger">加载Agent状态时发生错误: ' + error.message + '</div>';
        }
      }
      
      // 显示服务器编辑提示
      function showServerEdit(serverId) {
        showAlert(serverId + ' 编辑功能开发中', 'info');
      }
      
      // 显示提示信息
      function showAlert(message, type = 'info') {
        const alertDiv = document.getElementById('ws-alert');
        alertDiv.className = 'alert ' + type;
        alertDiv.textContent = message;
        
        setTimeout(() => {
          alertDiv.className = '';
          alertDiv.textContent = '';
        }, 5000);
      }
      
      // 加载服务器列表 - 简化版本
      async function loadServers() {
        try {
          const serversList = document.getElementById('servers-list');
          serversList.innerHTML = '<div class="loading">正在加载...</div>';
          
          const response = await fetch('/api/dashboard', addAuthHeader());
          const data = await response.json();
          
          if (data.ok && data.servers) {
            let html = '<div class="server-list">';
            
            data.servers.forEach(server => {
              html += '<div class="server-item" style="margin-bottom: 16px; padding: 16px; border: 1px solid var(--border); border-radius: 8px;">';
              html += '<h3>' + (server.name || server.id) + '</h3>';
              html += '<p>状态: ' + (server.online ? '🟢 在线' : '🔴 离线') + '</p>';
              html += '<p>系统: ' + (server.os || 'N/A') + ' ' + (server.arch || '') + '</p>';
              html += '<p>CPU: ' + (server.cpu_cores || 'N/A') + ' 核</p>';
              html += '<p>内存: ' + (server.mem_total ? Math.round(server.mem_total / 1024 / 1024 / 1024) + ' GB' : 'N/A') + '</p>';
              html += '<button class="btn" data-server-id="' + server.id + '" onclick="showServerEdit(\'' + server.id + '\')">编辑</button>';
              html += '</div>';
            });
            
            html += '</div>';
            serversList.innerHTML = html;
            showAlert('已加载 ' + data.servers.length + ' 台服务器', 'success');
          } else {
            serversList.innerHTML = '<div style="color: var(--text-secondary);">暂无服务器数据</div>';
          }
        } catch (error) {
          document.getElementById('servers-list').innerHTML = '<div style="color: var(--danger);">加载失败: ' + error.message + '</div>';
        }
      }
      
      // 页面加载时初始化
      document.addEventListener('DOMContentLoaded', function() {
        console.log('DOM loaded, initializing...');
        
        // 初始化其他功能
        loadWebSocketSettings();
      });
      
      // 检查查询参数中是否有token
      const urlParams = new URLSearchParams(window.location.search);
      const queryToken = urlParams.get('token');
      if (queryToken) {
        localStorage.setItem('admin_token', queryToken);
        // 清理URL中的token参数
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    </script>
  </body>
</html>`;
}
